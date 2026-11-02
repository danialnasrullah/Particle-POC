import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import type { ParticleConfig } from '../config/configuration';
import {
  TERMINAL_STATUSES,
  type ParsedRecordRow,
  type ParticlePatientRecord,
  type QueryAuditEntry,
  type QueryLoopRow,
} from '../particle-records/particle-records.types';
import type { ParticleStore, PatientRef } from './particle-store';

/** Ids become path segments, so only allow a conservative character set. */
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const MAX_TRACKED_WEBHOOK_EVENTS = 10_000;

/**
 * Local-disk implementation of `ParticleStore` for the POC.
 *
 * Layout under PARTICLE_DATA_DIR:
 *   practices/<practiceId>/patients/<elevaidId>/{patient,query-loop,parsed}.json
 *   practices/<practiceId>/patients/<elevaidId>/raw/*.json|zip
 *   practices/<practiceId>/patients/<elevaidId>/signal/*.json
 *   index/{particle-patients,active-loops,webhook-events}.json
 *   audit/particle-audit.jsonl
 *
 * Writes are atomic (tmp file + rename) and serialised per file in-process.
 * Single-instance only: not safe for multiple app replicas, which is fine for a POC.
 */
@Injectable()
export class FileParticleStore implements ParticleStore {
  private readonly logger = new Logger(FileParticleStore.name);
  private readonly root: string;
  private readonly locks = new Map<string, Promise<unknown>>();

  constructor(config: ConfigService) {
    const cfg = config.get<ParticleConfig>('particle');
    this.root = path.resolve(cfg?.dataDir ?? './data');
  }

  /* ---------------- patients ---------------- */

  async upsertPatient(record: ParticlePatientRecord): Promise<void> {
    const ref = { practiceId: record.practiceId, elevaidId: record.elevaidId };
    await this.writeJson(this.patientFile(ref, 'patient.json'), record);
    await this.updateJson<Record<string, PatientRef>>(
      this.indexFile('particle-patients.json'),
      {},
      (idx) => ({ ...idx, [record.particlePatientId]: ref }),
    );
  }

  async getPatient(ref: PatientRef): Promise<ParticlePatientRecord | null> {
    return this.readJson<ParticlePatientRecord>(
      this.patientFile(ref, 'patient.json'),
    );
  }

  async findByParticlePatientId(
    particlePatientId: string,
  ): Promise<PatientRef | null> {
    const idx = await this.readJson<Record<string, PatientRef>>(
      this.indexFile('particle-patients.json'),
    );
    return idx?.[particlePatientId] ?? null;
  }

  /* ---------------- query loop ---------------- */

  async saveLoop(row: QueryLoopRow): Promise<void> {
    const ref = { practiceId: row.practiceId, elevaidId: row.elevaidId };
    await this.writeJson(this.patientFile(ref, 'query-loop.json'), row);
    const key = `${row.practiceId}/${row.elevaidId}`;
    const terminal = TERMINAL_STATUSES.includes(row.status);
    await this.updateJson<string[]>(
      this.indexFile('active-loops.json'),
      [],
      (list) => {
        const set = new Set(list);
        if (terminal) set.delete(key);
        else set.add(key);
        return [...set];
      },
    );
  }

  async getLoop(ref: PatientRef): Promise<QueryLoopRow | null> {
    return this.readJson<QueryLoopRow>(
      this.patientFile(ref, 'query-loop.json'),
    );
  }

  async listActiveLoops(): Promise<QueryLoopRow[]> {
    const keys =
      (await this.readJson<string[]>(this.indexFile('active-loops.json'))) ??
      [];
    const rows: QueryLoopRow[] = [];
    for (const key of keys) {
      const [practiceId, elevaidId] = key.split('/');
      try {
        const row = await this.getLoop({ practiceId, elevaidId });
        if (row && !TERMINAL_STATUSES.includes(row.status)) rows.push(row);
      } catch (err) {
        this.logger.error(
          `[Particle Store] unreadable loop row key=${key}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    return rows;
  }

  /* ---------------- raw payloads ---------------- */

  async saveRaw(
    ref: PatientRef,
    label: string,
    payload: unknown,
  ): Promise<string> {
    const file = this.patientFile(
      ref,
      'raw',
      `${safeLabel(label)}-${stamp()}.json`,
    );
    await this.writeJson(file, payload);
    return path.relative(this.root, file);
  }

  async saveRawBinary(
    ref: PatientRef,
    filename: string,
    data: Buffer,
  ): Promise<string> {
    const file = this.patientFile(
      ref,
      'raw',
      `${stamp()}-${safeLabel(filename)}`,
    );
    await this.atomicWrite(file, data);
    return path.relative(this.root, file);
  }

  /* ---------------- parsed ---------------- */

  async saveParsed(row: ParsedRecordRow): Promise<void> {
    await this.writeJson(
      this.patientFile(
        { practiceId: row.practiceId, elevaidId: row.elevaidId },
        'parsed.json',
      ),
      row,
    );
  }

  async getParsed(ref: PatientRef): Promise<ParsedRecordRow | null> {
    return this.readJson<ParsedRecordRow>(this.patientFile(ref, 'parsed.json'));
  }

  /* ---------------- signal ---------------- */

  async saveSignalEvent(
    ref: PatientRef,
    eventId: string,
    event: unknown,
  ): Promise<void> {
    await this.writeJson(
      this.patientFile(ref, 'signal', `${stamp()}-${safeLabel(eventId)}.json`),
      event,
    );
  }

  async listSignalEvents(ref: PatientRef): Promise<unknown[]> {
    const dir = this.patientFile(ref, 'signal');
    let names: string[] = [];
    try {
      names = (await fs.readdir(dir)).filter((n) => n.endsWith('.json')).sort();
    } catch (err) {
      if (isNotFound(err)) return [];
      throw err;
    }
    const out: unknown[] = [];
    for (const n of names)
      out.push(await this.readJson<unknown>(path.join(dir, n)));
    return out;
  }

  async markWebhookEventProcessed(eventId: string): Promise<boolean> {
    let fresh = false;
    await this.updateJson<Record<string, string>>(
      this.indexFile('webhook-events.json'),
      {},
      (seen) => {
        if (seen[eventId]) return seen;
        fresh = true;
        const next = { ...seen, [eventId]: new Date().toISOString() };
        const keys = Object.keys(next);
        // Bound the file; oldest ids fall off first (insertion order).
        for (const k of keys.slice(
          0,
          Math.max(0, keys.length - MAX_TRACKED_WEBHOOK_EVENTS),
        ))
          delete next[k];
        return next;
      },
    );
    return fresh;
  }

  /* ---------------- audit ---------------- */

  async appendAudit(entry: QueryAuditEntry): Promise<void> {
    const file = path.join(this.root, 'audit', 'particle-audit.jsonl');
    await this.withLock(file, async () => {
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.appendFile(file, `${JSON.stringify(entry)}\n`, 'utf8');
    });
  }

  /* ---------------- internals ---------------- */

  private patientFile(ref: PatientRef, ...parts: string[]): string {
    assertSafeId(ref.practiceId, 'practiceId');
    assertSafeId(ref.elevaidId, 'elevaidId');
    return path.join(
      this.root,
      'practices',
      ref.practiceId,
      'patients',
      ref.elevaidId,
      ...parts,
    );
  }

  private indexFile(name: string): string {
    return path.join(this.root, 'index', name);
  }

  private async readJson<T>(file: string): Promise<T | null> {
    try {
      return JSON.parse(await fs.readFile(file, 'utf8')) as T;
    } catch (err) {
      if (isNotFound(err)) return null;
      throw err;
    }
  }

  private async writeJson(file: string, value: unknown): Promise<void> {
    await this.withLock(file, () =>
      this.atomicWrite(file, JSON.stringify(value, null, 2)),
    );
  }

  private async updateJson<T>(
    file: string,
    initial: T,
    fn: (current: T) => T,
  ): Promise<void> {
    await this.withLock(file, async () => {
      const current = (await this.readJson<T>(file)) ?? initial;
      await this.atomicWrite(file, JSON.stringify(fn(current), null, 2));
    });
  }

  private async atomicWrite(
    file: string,
    data: string | Buffer,
  ): Promise<void> {
    await fs.mkdir(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
    await fs.writeFile(tmp, data);
    await fs.rename(tmp, file);
  }

  private async withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(key) ?? Promise.resolve();
    const next = prev.catch(() => undefined).then(fn);
    this.locks.set(key, next);
    try {
      return await next;
    } finally {
      if (this.locks.get(key) === next) this.locks.delete(key);
    }
  }
}

export function assertSafeId(value: string, field: string): void {
  if (!SAFE_ID.test(value) || value.includes('..')) {
    throw new Error(`Invalid ${field} for storage path.`);
  }
}

function safeLabel(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 80);
}

function stamp(): string {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function isNotFound(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    (err as { code?: string }).code === 'ENOENT'
  );
}
