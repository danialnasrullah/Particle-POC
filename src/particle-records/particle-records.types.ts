import type {
  CodeDto,
  PractitionerDto,
  RedoxParsedData,
} from '../types/clinical.types';

/**
 * Particle-only outputs that have no slot in the main app's RedoxParsedData.
 * Kept separate so the clinical spine (dedupe -> categorise -> summaries) is untouched on merge.
 */
export interface ParticleTransitionDto {
  id: string;
  visitId?: string;
  /** admission | transfer | discharge | death (lower-cased from Particle). */
  status?: string;
  setting?: string;
  facilityName?: string;
  facilityNpi?: string;
  facilityType?: string;
  statusDateTime?: Date;
  visitStart?: Date;
  visitEnd?: Date;
  attendingPhysician?: PractitionerDto;
  admittingDiagnoses: { code?: CodeDto; description?: string }[];
  dischargeDiagnoses: { code?: CodeDto; description?: string }[];
  dischargeDisposition?: string;
  dischargeSummary?: string;
  possibleObservationStay?: boolean;
}

export interface ParticleAiCitationDto {
  id: string;
  resourceType?: string;
  resourceReferenceId?: string;
  documentReferenceId?: string;
  textSnippet?: string;
}

/** Particle Snapshot output. Always AI-generated: label it, show citations, require clinician review. */
export interface ParticleAiOutputDto {
  id: string;
  type: string;
  text?: string;
  createdAt?: Date;
  resourceReferenceIds: string[];
  citations: ParticleAiCitationDto[];
  isAiGenerated: true;
}

export interface ParticleExtras {
  transitions: ParticleTransitionDto[];
  aiOutputs: ParticleAiOutputDto[];
}

export interface ParticleParseResult {
  clinicalData: RedoxParsedData;
  extras: ParticleExtras;
  /** Per-domain counts, matching the main app's `resourceCounts` column. */
  resourceCounts: Record<string, number>;
  /** Total Flat rows received across all tables. */
  rawResourceCount: number;
  /** Flat tables present in the payload that this parser does not map yet. */
  unmappedTables: string[];
}

/* ---------------- Query loop state (merge target: a `particle_query_loop` table) ---------------- */

export type QueryLoopStatus =
  | 'QUEUED' // waiting for nextAttemptAt before submitting
  | 'SUBMITTED' // query accepted, polling status
  | 'RETRIEVING' // query finished, fetching + parsing Flat
  | 'COMPLETE' // parsed data stored
  | 'NO_DATA' // query finished but Flat was empty; re-query allowed after the 48h window
  | 'FAILED' // Particle reported FAILED, or a non-retryable error
  | 'STALLED'; // poll error budget or poll ceiling exhausted

export const TERMINAL_STATUSES: readonly QueryLoopStatus[] = [
  'COMPLETE',
  'NO_DATA',
  'FAILED',
  'STALLED',
];

export interface QueryLoopRow {
  practiceId: string;
  elevaidId: string;
  particlePatientId: string;
  status: QueryLoopStatus;
  queryId: string | null;
  lastRawState: string | null;
  attemptCount: number;
  pollErrors: number;
  nextAttemptAt: string; // ISO
  submittedAt: string | null;
  completedAt: string | null;
  terminalReason: string | null;
  requestedBy: string | null; // physician / user id that triggered the pull (audit)
  createdAt: string;
  updatedAt: string;
}

/* ---------------- Patient mapping (merge target: a `particle_patients` table) ---------------- */

export interface ParticlePatientRecord {
  practiceId: string;
  elevaidId: string;
  particlePatientId: string;
  /** SHA-256 of the demographics sent, to detect changes without storing them twice. */
  demographicsHash: string;
  monitoringSubscribed: boolean;
  registeredAt: string;
  updatedAt: string;
}

export interface ParsedRecordRow {
  practiceId: string;
  elevaidId: string;
  particlePatientId: string;
  queryId: string | null;
  parsedAt: string;
  clinicalData: RedoxParsedData;
  extras: ParticleExtras;
  resourceCounts: Record<string, number>;
  rawResourceCount: number;
  /** Flat tables, or FHIR resource types, present in the payload that the parser does not map. */
  unmappedTables: string[];
}

/** Audit entry for every outbound query (purpose-of-use compliance). Contains no clinical data. */
export interface QueryAuditEntry {
  at: string;
  practiceId: string;
  elevaidId: string;
  particlePatientId: string;
  action:
    | 'REGISTER'
    | 'QUERY_SUBMIT'
    | 'FLAT_RETRIEVE'
    | 'FHIR_RETRIEVE'
    | 'SUBSCRIBE'
    | 'UNSUBSCRIBE'
    | 'WEBHOOK';
  purposeOfUse?: string;
  requestedBy?: string | null;
  queryId?: string | null;
  outcome: 'OK' | 'ERROR';
  detail?: string;
}
