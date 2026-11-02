import type {
  ParsedRecordRow,
  ParticlePatientRecord,
  QueryAuditEntry,
  QueryLoopRow,
} from '../particle-records/particle-records.types';

/** DI token for the store, so the file implementation can be swapped for Postgres on merge. */
export const PARTICLE_STORE = Symbol('PARTICLE_STORE');

export interface PatientRef {
  practiceId: string;
  elevaidId: string;
}

/**
 * Persistence port for the Particle flow. Every read and write is scoped by
 * `practiceId` (tenant) + `elevaidId`; the only unscoped lookup is
 * `findByParticlePatientId`, which webhooks need to route an event back to its tenant.
 *
 * POC: `FileParticleStore` (JSON on local disk).
 * Merge: implement against `DatabaseService` with tables
 *   particle_patients, particle_query_loop, particle_parsed_records,
 *   particle_signal_events, particle_webhook_events, particle_audit_log.
 */
export interface ParticleStore {
  upsertPatient(record: ParticlePatientRecord): Promise<void>;
  getPatient(ref: PatientRef): Promise<ParticlePatientRecord | null>;
  findByParticlePatientId(
    particlePatientId: string,
  ): Promise<PatientRef | null>;

  saveLoop(row: QueryLoopRow): Promise<void>;
  getLoop(ref: PatientRef): Promise<QueryLoopRow | null>;
  /** All loop rows not yet in a terminal state. */
  listActiveLoops(): Promise<QueryLoopRow[]>;

  /** Keep the untouched upstream payload for replay/debugging. Returns a storage locator. */
  saveRaw(
    ref: PatientRef,
    label: string,
    payload: unknown,
  ): Promise<string>;
  saveRawBinary(
    ref: PatientRef,
    filename: string,
    data: Buffer,
  ): Promise<string>;

  saveParsed(row: ParsedRecordRow): Promise<void>;
  getParsed(ref: PatientRef): Promise<ParsedRecordRow | null>;

  saveSignalEvent(
    ref: PatientRef,
    eventId: string,
    event: unknown,
  ): Promise<void>;
  listSignalEvents(ref: PatientRef): Promise<unknown[]>;

  /**
   * Record a webhook event id. Returns `false` when it was already recorded,
   * so duplicate CloudEvent deliveries are processed once.
   */
  markWebhookEventProcessed(eventId: string): Promise<boolean>;

  appendAudit(entry: QueryAuditEntry): Promise<void>;
}
