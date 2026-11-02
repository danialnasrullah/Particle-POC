/**
 * Wire types for the Particle Query Flow API (v2) and Signal webhooks.
 *
 * Sources: particle-connect `agent-documentation/02-api-reference.md`,
 * `11-flat-data-contract.md` (v2.8.1), `12-notification-data-contract.md`,
 * and the Prod-Sandbox Signal Postman collection.
 */

export type ParticleGender = 'MALE' | 'FEMALE';

/** Body for POST /api/v2/patients. Same `patient_id` + same demographics = update; different = overlay error. */
export interface ParticlePatientRegistration {
  given_name: string;
  family_name: string;
  date_of_birth: string; // YYYY-MM-DD
  gender: ParticleGender;
  postal_code: string;
  address_city: string;
  address_state: string; // two-letter abbreviation
  patient_id: string; // our external id (elevAID patient UUID)
  address_lines?: string[];
  telephone?: string;
  email?: string;
}

export interface ParticlePatientResponse {
  particle_patient_id: string;
  patient_id?: string;
  [key: string]: unknown;
}

export interface ParticleQuerySubmitResponse {
  particle_patient_id?: string;
  external_patient_id?: string;
  purpose_of_use?: string;
  query_id?: string;
}

/**
 * Normalised query state. Particle's docs disagree on the vocabulary
 * (`state`: PENDING/PROCESSING/COMPLETE/PARTIAL/FAILED in the SDK docs vs
 * `status`: SCHEDULED/RUNNING/COMPLETE/TIMEOUT on docs.particlehealth.com),
 * so the client accepts both and maps to this set.
 */
export type NormalisedQueryState =
  'PENDING' | 'RUNNING' | 'COMPLETE' | 'PARTIAL' | 'FAILED' | 'UNKNOWN';

export interface ParticleQueryStatus {
  state: NormalisedQueryState;
  rawState: string | null;
  queryId: string | null;
  filesAvailable: number | null;
  errorMessage: string | null;
}

/** A Flat row. All values arrive as strings except a few numeric/boolean columns; empty string means null. */
export type FlatRow = Record<
  string,
  string | number | boolean | null | undefined
>;

/** GET /api/v2/patients/{id}/fhir response: a FHIR R4 Bundle. Resources stay untyped, as in the main app's parser. */
export interface ParticleFhirBundle {
  resourceType?: string;
  entry?: { resource?: { resourceType?: string; [k: string]: unknown } }[];
  link?: { relation?: string; url?: string }[];
  [k: string]: unknown;
}

/** GET /api/v2/patients/{id}/flat response: camelCase table key -> rows. */
export type ParticleFlatResponse = Partial<Record<FlatResourceKey, FlatRow[]>> &
  Record<string, unknown>;

export const FLAT_RESOURCE_KEYS = [
  'aICitations',
  'aIOutputs',
  'allergies',
  'coverages',
  'documentReferences',
  'encounters',
  'familyMemberHistories',
  'immunizations',
  'labs',
  'locations',
  'medicationFills',
  'medications',
  'organizations',
  'patients',
  'practitioners',
  'problems',
  'procedures',
  'recordSources',
  'socialHistories',
  'sources',
  'transitions',
  'vitalSigns',
] as const;

export type FlatResourceKey = (typeof FLAT_RESOURCE_KEYS)[number];

/* ------------------------------------------------------------------ */
/* Signal webhooks (CloudEvents 1.0)                                   */
/* ------------------------------------------------------------------ */

export const PARTICLE_EVENT_TYPES = {
  QUERY: 'com.particlehealth.api.v2.query',
  QUERY_V1: 'com.particlehealth.api.v1.query',
  TRANSITION: 'com.particlehealth.api.v2.transitionalerts',
  ENCOUNTER: 'com.particlehealth.api.v2.encounteralerts',
  AI_OUTPUTS: 'com.particlehealth.api.v2.aioutputs',
  AI_OUTPUT: 'com.particlehealth.api.v2.aioutput',
  HL7V2: 'com.particlehealth.api.v2.hl7v2',
  CONSENT: 'com.particlehealth.api.v2.consent',
  MEDICATION_FILLS: 'com.particlehealth.api.v2.medicationfills',
} as const;

export interface ParticleCloudEvent<T = Record<string, unknown>> {
  specversion: string;
  id: string;
  source?: string;
  type: string;
  subject?: string;
  time?: string;
  datacontenttype?: string;
  data?: T;
}

export interface QueryCompleteData {
  query_id?: string;
  person_id?: string;
  patient_id?: string;
  particle_patient_id?: string;
  external_patient_id?: string;
  file_count?: string; // string, not number
  status?: string;
  purpose?: string;
}

export interface TransitionAlertData {
  particle_patient_id?: string;
  external_patient_id?: string;
  event_type?: string; // admission | discharge | transfer | death (sandbox may send A01 etc.)
  event_sequence?: number;
  is_final_event?: string | boolean;
  resources?: { file_id?: string; resource_ids?: string[] }[];
}

export interface AiOutputsData {
  query_id?: string;
  particle_patient_id?: string;
  outputs?: { ai_output_id: string; output_type: string; status: string }[];
}
