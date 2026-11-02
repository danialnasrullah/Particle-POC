import { ConfigService } from '@nestjs/config';
import type { ParticleConfig } from '../config/configuration';
import type {
  ParsedRecordRow,
  ParticlePatientRecord,
  QueryAuditEntry,
  QueryLoopRow,
} from '../particle-records/particle-records.types';
import { TERMINAL_STATUSES } from '../particle-records/particle-records.types';
import type { ParticleStore, PatientRef } from '../storage/particle-store';
import type { RegisterPatientDto } from '../particle-records/dto/register-patient.dto';

export const PRACTICE_A = '11111111-1111-4111-8111-111111111111';
export const PRACTICE_B = '22222222-2222-4222-8222-222222222222';
export const ELEVAID_1 = '33333333-3333-4333-8333-333333333333';
export const PPID_1 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

export function buildParticleConfig(
  overrides: Partial<ParticleConfig> = {},
): ParticleConfig {
  return {
    env: 'sandbox',
    baseUrl: 'https://sandbox.particlehealth.test',
    allowProduction: false,
    clientId: 'test-client',
    clientSecret: 'test-secret',
    scope: 'projects/test',
    webhookSigningKey: '',
    webhookToleranceSeconds: 300,
    purposeOfUse: 'TREATMENT',
    requeryMinHours: 48,
    loop: {
      enabled: false,
      intervalMs: 1000,
      pollCeilingMinutes: 30,
      maxPollErrors: 3,
    },
    dataDir: './data-test',
    ...overrides,
  };
}

export function buildConfigService(
  particle: Partial<ParticleConfig> = {},
  extra: Record<string, unknown> = {},
): ConfigService {
  const values: Record<string, unknown> = {
    particle: buildParticleConfig(particle),
    ...extra,
  };
  return { get: (key: string) => values[key] } as unknown as ConfigService;
}

export function buildRegisterDto(
  overrides: Partial<RegisterPatientDto> = {},
): RegisterPatientDto {
  return {
    practiceId: PRACTICE_A,
    elevaidId: ELEVAID_1,
    firstName: 'Test',
    lastName: 'Patient',
    dob: '1970-12-26',
    genderAtBirth: 'F',
    address: {
      city: 'Boston',
      state: 'MA',
      zip: '02215',
      lines: ['1 Test St'],
    },
    subscribeMonitoring: false,
    requestedBy: 'physician-1',
    ...overrides,
  } as RegisterPatientDto;
}

export function buildPatientRecord(
  overrides: Partial<ParticlePatientRecord> = {},
): ParticlePatientRecord {
  const now = new Date().toISOString();
  return {
    practiceId: PRACTICE_A,
    elevaidId: ELEVAID_1,
    particlePatientId: PPID_1,
    demographicsHash: 'hash',
    monitoringSubscribed: false,
    registeredAt: now,
    updatedAt: now,
    ...overrides,
  };
}

export function buildLoopRow(
  overrides: Partial<QueryLoopRow> = {},
): QueryLoopRow {
  const now = new Date().toISOString();
  return {
    practiceId: PRACTICE_A,
    elevaidId: ELEVAID_1,
    particlePatientId: PPID_1,
    status: 'QUEUED',
    queryId: null,
    lastRawState: null,
    attemptCount: 0,
    pollErrors: 0,
    nextAttemptAt: now,
    submittedAt: null,
    completedAt: null,
    terminalReason: null,
    requestedBy: 'physician-1',
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

/** In-memory ParticleStore for service tests. Same tenant-scoping contract as the file store. */
export class InMemoryParticleStore implements ParticleStore {
  patients = new Map<string, ParticlePatientRecord>();
  byPpid = new Map<string, PatientRef>();
  loops = new Map<string, QueryLoopRow>();
  parsed = new Map<string, ParsedRecordRow>();
  raw: { ref: PatientRef; label: string; payload: unknown }[] = [];
  signal = new Map<string, unknown[]>();
  webhookIds = new Set<string>();
  audit: QueryAuditEntry[] = [];

  private key(ref: PatientRef) {
    return `${ref.practiceId}/${ref.elevaidId}`;
  }
  async upsertPatient(r: ParticlePatientRecord) {
    this.patients.set(this.key(r), r);
    this.byPpid.set(r.particlePatientId, {
      practiceId: r.practiceId,
      elevaidId: r.elevaidId,
    });
  }
  async getPatient(ref: PatientRef) {
    return this.patients.get(this.key(ref)) ?? null;
  }
  async findByParticlePatientId(id: string) {
    return this.byPpid.get(id) ?? null;
  }
  async saveLoop(row: QueryLoopRow) {
    this.loops.set(this.key(row), row);
  }
  async getLoop(ref: PatientRef) {
    return this.loops.get(this.key(ref)) ?? null;
  }
  async listActiveLoops() {
    return [...this.loops.values()].filter(
      (r) => !TERMINAL_STATUSES.includes(r.status),
    );
  }
  async saveRaw(ref: PatientRef, label: string, payload: unknown) {
    this.raw.push({ ref, label, payload });
    return `raw/${label}`;
  }
  async saveRawBinary(ref: PatientRef, filename: string) {
    return `raw/${filename}`;
  }
  async saveParsed(row: ParsedRecordRow) {
    this.parsed.set(this.key(row), row);
  }
  async getParsed(ref: PatientRef) {
    return this.parsed.get(this.key(ref)) ?? null;
  }
  async saveSignalEvent(ref: PatientRef, _id: string, event: unknown) {
    const list = this.signal.get(this.key(ref)) ?? [];
    list.push(event);
    this.signal.set(this.key(ref), list);
  }
  async listSignalEvents(ref: PatientRef) {
    return this.signal.get(this.key(ref)) ?? [];
  }
  async markWebhookEventProcessed(id: string) {
    if (this.webhookIds.has(id)) return false;
    this.webhookIds.add(id);
    return true;
  }
  async appendAudit(e: QueryAuditEntry) {
    this.audit.push(e);
  }
}

/** Unsigned JWT with the given exp (seconds). Signature is irrelevant: the client only reads exp. */
export function fakeJwt(expSeconds: number): string {
  const enc = (o: object) =>
    Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${enc({ alg: 'none' })}.${enc({ exp: expSeconds })}.sig`;
}
