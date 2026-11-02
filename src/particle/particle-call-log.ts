import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { ParticleConfig } from '../config/configuration';

const MAX_ENTRIES = 300;
const MAX_TEXT = 1500;

/** One upstream Particle call, as shown on the POC test page's progress log. */
export interface ParticleCallEntry {
  seq: number;
  at: string;
  label: string;
  method: string;
  path: string;
  /** HTTP status; null when Particle was unreachable. */
  status: number | null;
  ms: number;
  /** Request body summary (POSTs only). */
  request?: string;
  /** Response body summary; tokens are redacted, large payloads are summarised. */
  response: string;
  particlePatientId: string | null;
}

/**
 * In-memory ring buffer of recent Particle calls so the test page can show what is
 * happening behind the curtain. Sandbox only: bodies carry PHI, so nothing is kept
 * in any other environment. Not part of the merge into the main app.
 */
@Injectable()
export class ParticleCallLog {
  private seq = 0;
  private readonly entries: ParticleCallEntry[] = [];

  constructor(private readonly config: ConfigService) {}

  record(call: {
    label: string;
    method: string;
    path: string;
    status: number | null;
    ms: number;
    requestBody?: unknown;
    responseBody?: unknown;
  }): void {
    if (this.config.get<ParticleConfig>('particle')?.env !== 'sandbox') return;
    const fromPath = /\/patients\/([0-9a-f-]{36})/i.exec(call.path)?.[1];
    const fromBody = (call.responseBody as { particle_patient_id?: unknown })
      ?.particle_patient_id;
    this.entries.push({
      seq: ++this.seq,
      at: new Date().toISOString(),
      label: call.label,
      method: call.method.toUpperCase(),
      path: call.path,
      status: call.status,
      ms: call.ms,
      request:
        call.requestBody === undefined
          ? undefined
          : summarizeBody(call.requestBody, call.label),
      response: summarizeBody(call.responseBody, call.label),
      particlePatientId:
        fromPath ?? (typeof fromBody === 'string' ? fromBody : null),
    });
    if (this.entries.length > MAX_ENTRIES) this.entries.shift();
  }

  /** Calls for one Particle patient, plus token fetches (which carry no patient data). */
  list(particlePatientId: string): ParticleCallEntry[] {
    return this.entries.filter(
      (e) => e.particlePatientId === particlePatientId || e.label === 'auth',
    );
  }
}

/** Short, human-readable view of a request/response body. Never returns a token. */
export function summarizeBody(body: unknown, label: string): string {
  if (body === undefined || body === null || body === '') return '(empty)';
  if (label === 'auth') {
    // Success carries the JWT; never show auth bodies at all.
    return `(redacted, ${JSON.stringify(body).length} chars)`;
  }
  if (Buffer.isBuffer(body) || body instanceof ArrayBuffer) {
    return `(binary, ${body.byteLength} bytes)`;
  }
  if (typeof body === 'string') return truncate(body);

  const obj = body as Record<string, unknown>;
  if (obj.resourceType === 'Bundle' && Array.isArray(obj.entry)) {
    const counts: Record<string, number> = {};
    for (const e of obj.entry as { resource?: { resourceType?: string } }[]) {
      const t = e.resource?.resourceType ?? '?';
      counts[t] = (counts[t] ?? 0) + 1;
    }
    const parts = Object.entries(counts)
      .sort((a, b) => b[1] - a[1])
      .map(([t, n]) => `${t} ${n}`);
    return `FHIR Bundle (${String(obj.type ?? '?')}), ${obj.entry.length} entries: ${parts.join(', ')}`;
  }

  const json = JSON.stringify(body);
  if (json.length <= MAX_TEXT) return json;
  if (Array.isArray(body)) return `array of ${body.length} items, ${json.length} bytes`;
  // Large object (e.g. Flat): one line per top-level key.
  const keys = Object.entries(obj).map(([k, v]) =>
    Array.isArray(v) ? `${k}: ${v.length} rows` : `${k}: ${typeof v}`,
  );
  return `${json.length} bytes. ${keys.join(', ')}`;
}

function truncate(s: string): string {
  return s.length <= MAX_TEXT ? s : `${s.slice(0, MAX_TEXT)}… (${s.length} chars)`;
}
