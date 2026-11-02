// COPIED from redox-backend-nest/src/types/clinical.types.ts so the POC parser emits
// exactly the shape the main app consumes. Only change: DataSource.PARTICLE added.
// On merge: delete this file and add PARTICLE to the main app's DataSource enum.

export enum ClinicalSyncStatus {
  QUEUED = 'queued',
  PROCESSING = 'processing',
  COMPLETED = 'completed',
  FAILED = 'failed',
}

export enum ClinicalStatus {
  ACTIVE = 'active',
  RESOLVED = 'resolved',
  INACTIVE = 'inactive',
  RECURRENCE = 'recurrence',
  UNKNOWN = 'unknown', // Added to handle missing or explicitly unknown status in source FHIR data (e.g. CareEvolution)
}

export enum ConditionSeverity {
  HIGH = 'high',
  MODERATE = 'moderate',
  LOW = 'low',
}

export enum MedicationStatus {
  ACTIVE = 'active',
  COMPLETED = 'completed',
  DISCONTINUED = 'discontinued',
  ON_HOLD = 'on_hold',
  STOPPED = 'stopped',
}

export enum LabResultStatus {
  NORMAL = 'normal',
  ABNORMAL = 'abnormal',
  ELEVATED = 'elevated',
  LOW = 'low',
  CRITICAL = 'critical',
}

export enum VitalStatus {
  NORMAL = 'normal',
  HIGH = 'high',
  LOW = 'low',
  CRITICAL = 'critical',
}

export enum AllergySeverity {
  MILD = 'mild',
  MODERATE = 'moderate',
  SEVERE = 'severe',
}

export enum AllergyStatus {
  ACTIVE = 'active',
  INACTIVE = 'inactive',
  RESOLVED = 'resolved',
}

export enum AllergyCriticality {
  LOW = 'low',
  HIGH = 'high',
  UNABLE_TO_ASSESS = 'unable-to-assess',
}

export enum ImmunizationStatus {
  COMPLETED = 'completed',
  NOT_DONE = 'not_done',
}

export enum ImagingStatus {
  NORMAL = 'normal',
  ABNORMAL = 'abnormal',
  CLEAR = 'clear',
  PENDING = 'pending',
}

export enum ProcedureStatus {
  COMPLETED = 'completed',
  IN_PROGRESS = 'in-progress',
  NOT_DONE = 'not-done',
  ON_HOLD = 'on-hold',
  STOPPED = 'stopped',
  ENTERED_IN_ERROR = 'entered-in-error',
  UNKNOWN = 'unknown',
}

export enum NoteType {
  ANNUAL_CHECKUP = 'annual_checkup',
  FOLLOW_UP = 'follow_up',
  SPECIALIST = 'specialist',
  URGENT = 'urgent',
  GENERAL = 'general',
  PROGRESS_NOTE = 'Progress Note',
  CONSULT = 'consult',
  PROGRESS = 'progress',
  DISCHARGE = 'discharge',
  SURGICAL = 'surgical',
}

export enum DataSource {
  /**
   * Retained deliberately, not dead. Redox was removed as a data source, but
   * clinical rows written while it was live still carry `source: 'redox'` in
   * their stored JSON, so this enum must keep describing values present in the
   * data. Nothing writes it any more.
   */
  REDOX = 'redox',
  OCR = 'ocr',
  MANUAL = 'manual',
  /**
   * EPIC / CERNER / MEDHOST are retained for the same reason as REDOX above:
   * the SMART-on-FHIR POC that produced them has been removed, but rows written
   * while it ran still carry these values in their stored JSON. EPIC also
   * remains the fallback in ParserService.mapSourceToDataSource. Nothing else
   * writes them.
   */
  EPIC = 'epic',
  CERNER = 'cerner',
  MEDHOST = 'medhost',
  FASTEN = 'fasten',
  METRIPORT = 'metriport',
  PARTICLE = 'particle',
  PAPER_OCR = 'paper_ocr',
  USER_INPUT = 'user_input',
  SELF_UPLOAD = 'self-upload',
}

export interface CodeDto {
  system: string;
  value: string;
}

export interface ReferenceDto {
  reference: string;
  display?: string;
}

export interface PractitionerDto {
  name: string;
  npi?: string;
  specialty?: string;
}

export interface FacilityDto {
  name: string;
  address?: string;
  type?: string;
}

export interface ReferenceRangeDto {
  low?: string;
  high?: string;
  unit?: string;
  text?: string;
}

export interface EncounterDto {
  id?: string;
  type: string;
  /** FHIR Encounter.class code (v3-ActCode), e.g. 'AMB', 'IMP', 'EMER'. */
  classCode?: string;
  periodStart?: Date;
  periodEnd?: Date;
  location?: FacilityDto;
  participants?: PractitionerDto[];
  reasonCodes?: CodeDto[];
  reasonReference?: ReferenceDto[];
  source?: DataSource;
  recordedAt?: Date;
}

export interface ConditionDto {
  id?: string;
  display: string;
  code?: CodeDto;
  // ALL codings on the source Condition (deduped), not just the single primary
  // `code`. Preserved so downstream consumers (e.g. problem categorization) can
  // see the ICD codes even when `code` resolved to a non-ICD system.
  codes?: CodeDto[];
  clinicalStatus: ClinicalStatus;
  severity?: ConditionSeverity;
  onsetDate?: Date;
  resolvedDate?: Date;
  asserter?: PractitionerDto;
  encounterReference?: string;
  encounterId?: string;
  encounter?: EncounterDto;
  source: DataSource;
  externalId?: string;
  recordedAt?: Date;
  summary?: string;
  summary_updated_at?: string;
  summary_status?: string;
}

export interface MedicationDto {
  id?: string;
  display: string;
  code?: CodeDto;
  dosage?: string;
  frequency?: string;
  frequencyNumber?: number;
  period?: number;
  periodUnit?: string;
  route?: string;
  status: MedicationStatus;
  /** Coarse body system from the name-based lookup table; null if unmatched. */
  body_system?: string | null;
  requester?: PractitionerDto;
  reasonReference?: ReferenceDto[];
  reason?: ConditionDto;
  // reasonCodes?: CodeDto[];
  // contextualReasonCodes?: CodeDto[];
  encounterReference?: string;
  encounterId?: string;
  startDate?: Date;
  endDate?: Date;
  source?: DataSource;
  externalId?: string;
  recordedAt?: Date;
}

export interface LabResultDto {
  id?: string;
  display: string;
  code?: CodeDto;
  status: LabResultStatus;
  /**
   * Raw FHIR Observation.interpretation display/text (e.g. "High", "Normal").
   * `status` is the coarse derived enum; this keeps the source wording, which
   * carries nuance the enum flattens away.
   */
  interpretation?: string;
  /** Coarse body system from the name-based lookup table; null if unmatched. */
  body_system?: string | null;
  value?: string;
  unit?: string;
  referenceRange?: ReferenceRangeDto;
  effectiveDate?: Date;
  effectiveEndDate?: Date;
  encounterReference?: string;
  encounterId?: string;
  // contextualReasonCodes?: CodeDto[];
  encounter?: EncounterDto;
  reasonReference?: ReferenceDto[];
  basedOn?: ReferenceDto[];
  focus?: ReferenceDto[];
  source?: DataSource;
  externalId?: string;
  recordedAt?: Date;
}

export interface VitalDto {
  id?: string;
  display: string;
  code?: CodeDto;
  value: string;
  unit?: string;
  /** Coarse body system from the name-based lookup table; null if unmatched. */
  body_system?: string | null;
  status?: VitalStatus;
  /** Raw FHIR Observation.interpretation display/text, when the source sets it. */
  interpretation?: string;
  recordedDate?: Date;
  recordedEndDate?: Date;
  encounterReference?: string;
  encounterId?: string;
  // contextualReasonCodes?: CodeDto[];
  encounter?: EncounterDto;
  reasonReference?: ReferenceDto[];
  basedOn?: ReferenceDto[];
  focus?: ReferenceDto[];
  source?: DataSource;
  externalId?: string;
  recordedAt?: Date;
}

export interface AllergyReactionDto {
  substance?: string;
  manifestations: string[];
  severity?: AllergySeverity;
  description?: string;
}

export interface AllergyDto {
  id: string;
  display: string;
  /** Primary coding on AllergyIntolerance.code (RxNorm/SNOMED/UNII). */
  code?: CodeDto;
  /** Every usable coding on AllergyIntolerance.code, deduped. */
  codes?: CodeDto[];
  reaction?: string;
  reactions?: AllergyReactionDto[];
  severity?: AllergySeverity;
  /** Clinical risk of the allergen, from AllergyIntolerance.criticality. */
  criticality?: AllergyCriticality;
  /** FHIR AllergyIntolerance.type — 'allergy' or 'intolerance'. */
  allergyType?: string;
  /** FHIR AllergyIntolerance.category — e.g. ['medication'], ['food']. */
  categories?: string[];
  onsetDate?: Date;
  status: AllergyStatus;
  asserter?: PractitionerDto;
  encounterReference?: string;
  encounterId?: string;
  // contextualReasonCodes?: CodeDto[];
  reasonReference?: ReferenceDto[];
  source?: DataSource;
  recordedAt?: Date;
}

export interface ImmunizationDto {
  id: string;
  display: string;
  /** Primary coding on Immunization.vaccineCode (usually CVX). */
  code?: CodeDto;
  /** Every usable coding on Immunization.vaccineCode, deduped. */
  codes?: CodeDto[];
  manufacturer?: string;
  lotNumber?: string;
  /** Anatomical site of administration, from Immunization.site. */
  site?: string;
  route?: string;
  /** Administered amount rendered as "<value> <unit>". */
  doseQuantity?: string;
  doseNumber?: number;
  seriesDoses?: number;
  expirationDate?: Date;
  administeredDate?: Date;
  status: ImmunizationStatus;
  location?: FacilityDto;
  encounterReference?: string;
  encounterId?: string;
  // contextualReasonCodes?: CodeDto[];
  reasonReference?: ReferenceDto[];
  source?: DataSource;
  recordedAt?: Date;
}

export interface ImagingResultDto {
  id: string;
  scanType: string;
  code?: CodeDto;
  bodyPart?: string;
  status: ImagingStatus;
  performedDate?: Date;
  performedEndDate?: Date;
  findings?: string;
  performer?: FacilityDto;
  /**
   * Set when this entry is a projection of a Procedure resource rather than a
   * radiology DiagnosticReport. The same study therefore also appears in
   * `procedures` — consumers that show both domains must not double-count it.
   */
  derivedFromProcedureId?: string;
  encounterReference?: string;
  encounterId?: string;
  // contextualReasonCodes?: CodeDto[];
  encounter?: EncounterDto;
  reasonReference?: ReferenceDto[];
  basedOn?: ReferenceDto[];
  source?: DataSource;
  recordedAt?: Date;
}

export interface ClinicalNoteDto {
  id?: string;
  noteText: string;
  noteType?: NoteType;
  noteDate?: Date;
  author?: PractitionerDto;
  encounterReference?: string;
  encounterId?: string;
  // contextualReasonCodes?: CodeDto[];
  encounter?: EncounterDto;
  reasonReference?: ReferenceDto[];
  source?: DataSource;
  recordedAt?: Date;
}

export interface CoverageDto {
  id?: string;
  status: string;
  type?: string;
  subscriberName?: string;
  subscriberId?: string;
  beneficiaryName?: string;
  relationship?: string;
  payor?: string;
  planName?: string;
  groupName?: string;
  periodStart?: Date;
  periodEnd?: Date;
  source?: DataSource;
  recordedAt?: Date;
}

export interface ProcedureDto {
  id?: string;
  display: string;
  code?: CodeDto;
  /** Every usable coding on Procedure.code, deduped. */
  codes?: CodeDto[];
  status: ProcedureStatus;
  category?: string;
  /** Anatomical site(s) from Procedure.bodySite, comma-joined. */
  bodySite?: string;
  performedDate?: Date;
  performedEndDate?: Date;
  performer?: PractitionerDto;
  location?: FacilityDto;
  reasonReference?: ReferenceDto[];
  encounterReference?: string;
  encounterId?: string;
  source?: DataSource;
  recordedAt?: Date;
}

export interface FamilyHistoryConditionDto {
  display: string;
  code?: CodeDto;
  codes?: CodeDto[];
  /** Age or date of onset in the relative, when the source records it. */
  onsetText?: string;
  /** True when the condition is recorded as the relative's cause of death. */
  contributedToDeath?: boolean;
}

export interface FamilyHistoryDto {
  id: string;
  /** Relationship to the patient, e.g. 'Father', 'Mother', 'Sibling'. */
  relationship: string;
  /** v3-RoleCode for the relationship, e.g. 'FTH', 'MTH'. */
  relationshipCode?: string;
  /** Administrative gender of the relative, when recorded. */
  sex?: string;
  deceased?: boolean;
  conditions: FamilyHistoryConditionDto[];
  source?: DataSource;
  recordedAt?: Date;
}

export interface SocialHistoryDto {
  id: string;
  /** What was recorded, e.g. 'Tobacco smoking status'. */
  display: string;
  code?: CodeDto;
  codes?: CodeDto[];
  /** The recorded answer, e.g. 'Never smoker'. */
  value: string;
  unit?: string;
  effectiveDate?: Date;
  encounterReference?: string;
  encounterId?: string;
  source?: DataSource;
  recordedAt?: Date;
}

export interface CarePlanActivityDto {
  display?: string;
  code?: CodeDto;
  status?: string;
  performer?: PractitionerDto;
  scheduledStart?: Date;
  scheduledEnd?: Date;
}

export interface CarePlanDto {
  id: string;
  /** CarePlan.title, or a fallback built from the plan's category/intent. */
  display: string;
  status?: string;
  intent?: string;
  category?: string;
  description?: string;
  periodStart?: Date;
  periodEnd?: Date;
  activities?: CarePlanActivityDto[];
  /** CarePlan.addresses — the Conditions this plan is managing. */
  addresses?: ReferenceDto[];
  source?: DataSource;
  recordedAt?: Date;
}

/**
 * Derived gap status from a FHIR MeasureReport's group populations.
 *
 * Logic (evaluated in order):
 *   denominator.count === 0          → NOT_ELIGIBLE
 *   denominator-exclusion.count > 0  → EXCLUDED
 *   numerator.count > 0              → CLOSED
 *   otherwise                        → OPEN  (eligible, not excluded, measure not met)
 */
export enum CareGapStatus {
  OPEN = 'open',
  CLOSED = 'closed',
  EXCLUDED = 'excluded',
  NOT_ELIGIBLE = 'not-eligible',
}

/**
 * A single HEDIS care gap from Metriport's care-gaps API
 * (`GET /medical/v1/patient/{id}/care-gaps`).
 *
 * The response is a paginated FHIR envelope (`{metadata, results: Bundle[]}`).
 * Each Bundle entry with `resourceType === "MeasureReport"` becomes one DTO.
 * `raw` preserves the verbatim MeasureReport resource for audit and for any
 * supplemental fields not yet surfaced as typed properties.
 */
export interface CareGapDto {
  /** NCQA measure code extracted from MeasureReport.group[0].id, e.g. "BreastCancerScreening". */
  measureId: string;
  /** Full NCQA measure URL from MeasureReport.measure, e.g. "http://ncqa.org/fhir/Measure/BreastCancerScreening". */
  measureUrl?: string;
  /** Open/closed/excluded/not-eligible status derived from group populations. */
  gapStatus: CareGapStatus;
  /** MeasureReport.period.start */
  periodStart?: Date;
  /** MeasureReport.period.end */
  periodEnd?: Date;
  /** MeasureReport.subject.reference, e.g. "Patient/00000000-...". */
  patientReference?: string;
  /** The raw MeasureReport FHIR resource, verbatim. */
  raw: Record<string, unknown>;
  source?: DataSource;
  recordedAt?: Date;
}

export interface RedoxParsedData {
  patientId: string;
  problems?: ConditionDto[];
  medications?: MedicationDto[];
  labs?: LabResultDto[];
  vitals?: VitalDto[];
  allergies?: AllergyDto[];
  immunizations?: ImmunizationDto[];
  imaging?: ImagingResultDto[];
  notes?: ClinicalNoteDto[];
  encounters?: EncounterDto[];
  coverage?: CoverageDto[];
  procedures?: ProcedureDto[];
  familyHistory?: FamilyHistoryDto[];
  socialHistory?: SocialHistoryDto[];
  carePlans?: CarePlanDto[];
  careGaps?: CareGapDto[];
}
