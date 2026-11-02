import { Injectable, Logger } from '@nestjs/common';
import {
  AllergyStatus,
  ClinicalStatus,
  DataSource,
  ImmunizationStatus,
  LabResultStatus,
  MedicationStatus,
  NoteType,
  ProcedureStatus,
  type AllergyDto,
  type ClinicalNoteDto,
  type CodeDto,
  type ConditionDto,
  type CoverageDto,
  type EncounterDto,
  type FacilityDto,
  type FamilyHistoryDto,
  type ImmunizationDto,
  type LabResultDto,
  type MedicationDto,
  type PractitionerDto,
  type ProcedureDto,
  type RedoxParsedData,
  type SocialHistoryDto,
  type VitalDto,
} from '../types/clinical.types';
import type { FlatRow, ParticleFlatResponse } from '../particle/particle.types';
import {
  SYSTEMS,
  cleanUnit,
  collapseRepeated,
  indexBy,
  pairCodes,
  parseFlatDate,
  splitList,
  str,
  withNormalisedCodes,
  xmlToText,
} from './flat-utils';
import type {
  ParticleAiOutputDto,
  ParticleParseResult,
  ParticleTransitionDto,
} from './particle-records.types';

/** Flat tables the parser maps (directly or as lookups). Anything else is reported as unmapped. */
const HANDLED_TABLES = new Set([
  'problems',
  'medications',
  'labs',
  'vitalSigns',
  'allergies',
  'immunizations',
  'procedures',
  'encounters',
  'coverages',
  'familyMemberHistories',
  'socialHistories',
  'documentReferences',
  'transitions',
  'aIOutputs',
  'aICitations',
  // lookups / provenance
  'practitioners',
  'locations',
  'organizations',
  'patients',
  'recordSources',
  'sources',
]);

/** Note types that carry narrative worth showing; other DocumentReferences are section fragments. */
const NOTE_TYPE_RULES: { match: RegExp; type: NoteType }[] = [
  { match: /discharge/i, type: NoteType.DISCHARGE },
  { match: /progress/i, type: NoteType.PROGRESS },
  { match: /consult/i, type: NoteType.CONSULT },
  { match: /surg|operative/i, type: NoteType.SURGICAL },
  { match: /follow/i, type: NoteType.FOLLOW_UP },
  { match: /urgent|emergency/i, type: NoteType.URGENT },
];

interface Lookups {
  practitionersByRole: Map<string, FlatRow>;
  locations: Map<string, FlatRow>;
  organizations: Map<string, FlatRow>;
}

/**
 * Maps Particle Flat JSON to the main app's `RedoxParsedData`, plus Particle-only
 * extras (care transitions, AI outputs). Pure and deterministic: no I/O.
 *
 * Merge target: redox-backend-nest `src/particle-records/particle-flat-parser.service.ts`.
 * The output feeds the existing `dedupService.process` + `ClinicalDedupeService.merge` path
 * unchanged, the same way `parsePatientDataFromResources` output does for Metriport.
 */
@Injectable()
export class ParticleFlatParserService {
  private readonly logger = new Logger(ParticleFlatParserService.name);

  /**
   * Parse a Flat payload.
   *
   * @param elevaidId elevAID patient UUID, written to `RedoxParsedData.patientId`.
   * @param flat Payload from GET /flat (or a saved copy).
   * @returns Parsed clinical data, extras, counts and unmapped table names.
   */
  parse(elevaidId: string, flat: ParticleFlatResponse): ParticleParseResult {
    const t = (key: string): FlatRow[] => {
      const rows = flat[key];
      return Array.isArray(rows) ? (rows as FlatRow[]) : [];
    };

    const lookups: Lookups = {
      practitionersByRole: indexBy(
        t('practitioners'),
        'practitioner_role_id',
        true,
      ),
      locations: indexBy(t('locations'), 'location_id'),
      organizations: indexBy(t('organizations'), 'organization_id'),
    };

    const clinicalData: RedoxParsedData = {
      patientId: elevaidId,
      problems: uniqueBy(t('problems'), 'condition_id')
        .map((r) => this.condition(r))
        .filter(isDefined),
      medications: uniqueBy(t('medications'), 'medication_id')
        .map((r) => this.medication(r, lookups))
        .filter(isDefined),
      labs: uniqueBy(t('labs'), 'lab_observation_id')
        .map((r) => this.lab(r))
        .filter(isDefined),
      vitals: uniqueBy(t('vitalSigns'), 'vital_sign_observation_id')
        .map((r) => this.vital(r))
        .filter(isDefined),
      allergies: uniqueBy(t('allergies'), 'allergy_id')
        .map((r) => this.allergy(r))
        .filter(isDefined),
      immunizations: uniqueBy(t('immunizations'), 'immunization_id')
        .map((r) => this.immunization(r))
        .filter(isDefined),
      procedures: uniqueBy(t('procedures'), 'procedure_id')
        .map((r) => this.procedure(r))
        .filter(isDefined),
      encounters: uniqueBy(t('encounters'), 'encounter_id').map((r) =>
        this.encounter(r, lookups),
      ),
      coverage: uniqueBy(t('coverages'), 'coverage_id').map((r) =>
        this.coverage(r, lookups),
      ),
      familyHistory: uniqueBy(
        t('familyMemberHistories'),
        'family_member_history_id',
      )
        .map((r) => this.familyHistory(r))
        .filter(isDefined),
      socialHistory: uniqueBy(
        t('socialHistories'),
        'social_history_observation_id',
      )
        .map((r) => this.socialHistory(r))
        .filter(isDefined),
      notes: uniqueBy(t('documentReferences'), 'document_reference_id')
        .map((r) => this.note(r))
        .filter(isDefined),
    };

    const extras = {
      transitions: uniqueBy(t('transitions'), 'transition_id').map((r) =>
        this.transition(r),
      ),
      aiOutputs: this.aiOutputs(t('aIOutputs'), t('aICitations')),
    };

    const resourceCounts: Record<string, number> = {};
    for (const [k, v] of Object.entries(clinicalData)) {
      if (Array.isArray(v)) resourceCounts[k] = v.length;
    }
    resourceCounts.transitions = extras.transitions.length;
    resourceCounts.aiOutputs = extras.aiOutputs.length;

    let rawResourceCount = 0;
    const unmappedTables: string[] = [];
    for (const [key, rows] of Object.entries(flat)) {
      if (!Array.isArray(rows)) continue;
      rawResourceCount += rows.length;
      if (rows.length > 0 && !HANDLED_TABLES.has(key)) unmappedTables.push(key);
    }
    if (unmappedTables.length) {
      this.logger.warn(
        `[Particle Parser] unmapped Flat tables with rows: ${unmappedTables.join(', ')} elevaid_id=${elevaidId}`,
      );
    }

    return {
      clinicalData,
      extras,
      resourceCounts,
      rawResourceCount,
      unmappedTables,
    };
  }

  /* ----------------------------- domains ----------------------------- */

  private condition(r: FlatRow): ConditionDto | undefined {
    const codes = withNormalisedCodes(
      pairCodes(str(r, 'condition_code'), str(r, 'condition_code_system')),
      r,
      [{ column: 'condition_code_snomed', system: SYSTEMS.SNOMED }],
    );
    const display =
      collapseRepeated(str(r, 'condition_name')) ??
      str(r, 'condition_code_snomed_name');
    if (!display) return undefined;
    return {
      id: str(r, 'condition_id'),
      externalId: str(r, 'condition_id'),
      display,
      code: preferCode(codes, [SYSTEMS.ICD10CM, SYSTEMS.SNOMED]),
      codes,
      clinicalStatus: mapConditionStatus(str(r, 'condition_clinical_status')),
      onsetDate: parseFlatDate(str(r, 'condition_onset_date')),
      recordedAt: parseFlatDate(str(r, 'condition_recorded_date')),
      encounterId: str(r, 'encounter_id'),
      source: DataSource.PARTICLE,
    };
  }

  private medication(r: FlatRow, l: Lookups): MedicationDto | undefined {
    const codes = withNormalisedCodes(
      pairCodes(str(r, 'medication_code'), str(r, 'medication_code_system')),
      r,
      [{ column: 'medication_code_rxnorm', system: SYSTEMS.RXNORM }],
    );
    const display =
      collapseRepeated(str(r, 'medication_name')) ??
      str(r, 'medication_code_rxnorm_name');
    if (!display) return undefined;
    const doseValue = str(r, 'medication_statement_dose_value');
    const doseUnit = cleanUnit(str(r, 'medication_statement_dose_unit'));
    return {
      id: str(r, 'medication_id'),
      externalId: str(r, 'medication_id'),
      display,
      code: preferCode(codes, [SYSTEMS.RXNORM, SYSTEMS.NDC]),
      dosage: doseValue
        ? [doseValue, doseUnit].filter(Boolean).join(' ')
        : undefined,
      route: str(r, 'medication_statement_dose_route'),
      status: mapMedicationStatus(str(r, 'medication_statement_status')),
      requester: practitioner(l, str(r, 'practitioner_role_id')),
      startDate: parseFlatDate(str(r, 'medication_statement_start_time')),
      endDate: parseFlatDate(str(r, 'medication_statement_end_time')),
      source: DataSource.PARTICLE,
    };
  }

  private lab(r: FlatRow): LabResultDto | undefined {
    const codes = withNormalisedCodes(
      pairCodes(str(r, 'lab_code'), str(r, 'lab_code_system')),
      r,
      [{ column: 'lab_code_loinc', system: SYSTEMS.LOINC }],
    );
    const display = str(r, 'lab_name') ?? str(r, 'lab_code_loinc_name');
    if (!display) return undefined;
    const interpretation =
      str(r, 'lab_interpretation') ??
      str(r, 'lab_reference_range_interpretation');
    const low = str(r, 'lab_reference_range_low');
    const high = str(r, 'lab_reference_range_high');
    const rangeText = str(r, 'lab_reference_range_text');
    const reportId = str(r, 'diagnostic_report_id');
    return {
      id: str(r, 'lab_observation_id'),
      externalId: str(r, 'lab_observation_id'),
      display,
      code: preferCode(codes, [SYSTEMS.LOINC]),
      value:
        str(r, 'lab_value_quantity') ??
        str(r, 'lab_value') ??
        str(r, 'lab_value_string') ??
        str(r, 'lab_value_code') ??
        str(r, 'lab_value_boolean'),
      unit: str(r, 'lab_unit') ?? str(r, 'lab_unit_quantity'),
      referenceRange:
        low || high || rangeText
          ? {
              low,
              high,
              text: rangeText,
              unit: str(r, 'lab_reference_range_unit'),
            }
          : undefined,
      interpretation,
      status: mapLabStatus(interpretation),
      effectiveDate: parseFlatDate(str(r, 'lab_timestamp')),
      basedOn: reportId
        ? [
            {
              reference: `DiagnosticReport/${reportId}`,
              display: str(r, 'diagnostic_report_name'),
            },
          ]
        : undefined,
      source: DataSource.PARTICLE,
    };
  }

  private vital(r: FlatRow): VitalDto | undefined {
    const display =
      str(r, 'vital_sign_observation_name') ??
      str(r, 'vital_sign_observation_text');
    const value = str(r, 'vital_sign_observation_value');
    if (!display || value === undefined) return undefined;
    const codes = withNormalisedCodes(
      pairCodes(
        str(r, 'vital_sign_observation_code'),
        str(r, 'vital_sign_observation_code_system'),
      ),
      r,
      [{ column: 'vital_sign_observation_code_loinc', system: SYSTEMS.LOINC }],
    );
    return {
      id: str(r, 'vital_sign_observation_id'),
      externalId: str(r, 'vital_sign_observation_id'),
      display,
      code: preferCode(codes, [SYSTEMS.LOINC]),
      value,
      unit: cleanUnit(str(r, 'vital_sign_observation_unit')),
      recordedDate: parseFlatDate(str(r, 'vital_sign_observation_time')),
      source: DataSource.PARTICLE,
    };
  }

  private allergy(r: FlatRow): AllergyDto | undefined {
    const id = str(r, 'allergy_id');
    const display =
      collapseRepeated(str(r, 'allergy_name')) ??
      str(r, 'allergy_code_snomed_name');
    if (!id || !display) return undefined;
    const codes = withNormalisedCodes(
      pairCodes(str(r, 'allergy_code'), str(r, 'allergy_code_system')),
      r,
      [
        { column: 'allergy_code_snomed', system: SYSTEMS.SNOMED },
        { column: 'allergy_code_rxnorm', system: SYSTEMS.RXNORM },
      ],
    );
    const manifestations = splitList(
      str(r, 'reaction_manifestation'),
      /\s*[|,]\s*/,
    );
    return {
      id,
      display,
      code: preferCode(codes, [SYSTEMS.RXNORM, SYSTEMS.SNOMED]),
      codes,
      reaction: manifestations.join(', ') || undefined,
      reactions: manifestations.length ? [{ manifestations }] : undefined,
      onsetDate: parseFlatDate(str(r, 'allergy_onset_start')),
      // Flat has no allergy status column; CCDA allergy lists are active by convention. Confirm with Particle.
      status: str(r, 'allergy_onset_end')
        ? AllergyStatus.RESOLVED
        : AllergyStatus.ACTIVE,
      recordedAt: parseFlatDate(str(r, 'recorded_date')),
      source: DataSource.PARTICLE,
    };
  }

  private immunization(r: FlatRow): ImmunizationDto | undefined {
    const id = str(r, 'immunization_id');
    const display =
      str(r, 'immunization_name') ?? str(r, 'immunization_code_cvx_name');
    if (!id || !display) return undefined;
    const codes = withNormalisedCodes(
      pairCodes(
        str(r, 'immunization_code'),
        str(r, 'immunization_code_system'),
      ),
      r,
      [{ column: 'immunization_code_cvx', system: SYSTEMS.CVX }],
    );
    const doseValue = str(r, 'immunization_dosage_value');
    const statusRaw = (str(r, 'immunization_status') ?? '').toLowerCase();
    return {
      id,
      display,
      code: preferCode(codes, [SYSTEMS.CVX]),
      codes,
      manufacturer: str(r, 'immunization_manufacturer_name'),
      lotNumber: str(r, 'immunization_lot_number'),
      site: str(r, 'immunization_site'),
      route: str(r, 'immunization_route'),
      doseQuantity: doseValue
        ? [doseValue, cleanUnit(str(r, 'immunization_dosage_unit'))]
            .filter(Boolean)
            .join(' ')
        : undefined,
      administeredDate: parseFlatDate(str(r, 'immunization_occurrence_time')),
      status: statusRaw.includes('not')
        ? ImmunizationStatus.NOT_DONE
        : ImmunizationStatus.COMPLETED,
      source: DataSource.PARTICLE,
    };
  }

  private procedure(r: FlatRow): ProcedureDto | undefined {
    const display =
      collapseRepeated(str(r, 'procedure_name')) ??
      str(r, 'procedure_code_cpt_name');
    if (!display) return undefined;
    const codes = withNormalisedCodes(
      pairCodes(str(r, 'procedure_code'), str(r, 'procedure_code_system')),
      r,
      [
        { column: 'procedure_code_cpt', system: SYSTEMS.CPT },
        { column: 'procedure_code_snomed', system: SYSTEMS.SNOMED },
      ],
    );
    const performed = parseFlatDate(str(r, 'procedure_date_time'));
    const reason = str(r, 'procedure_reason');
    return {
      id: str(r, 'procedure_id'),
      display,
      code: preferCode(codes, [SYSTEMS.CPT, SYSTEMS.SNOMED]),
      codes,
      // Flat has no procedure status; a dated procedure in a CCDA history is treated as performed.
      status: performed ? ProcedureStatus.COMPLETED : ProcedureStatus.UNKNOWN,
      performedDate: performed,
      reasonReference: reason
        ? [{ reference: 'text', display: reason }]
        : undefined,
      encounterId: str(r, 'encounter_reference_id'),
      source: DataSource.PARTICLE,
    };
  }

  private encounter(r: FlatRow, l: Lookups): EncounterDto {
    const typeName = collapseRepeated(str(r, 'encounter_type_name'));
    const codes = pairCodes(
      str(r, 'encounter_type_code'),
      str(r, 'encounter_type_code_system'),
    );
    const locationId = splitList(
      str(r, 'location_id_references'),
      /\s*,\s*/,
    )[0];
    const participants = splitList(
      str(r, 'practitioner_role_id_references'),
      /\s*,\s*/,
    )
      .map((roleId) => practitioner(l, roleId))
      .filter(isDefined);
    return {
      id: str(r, 'encounter_id'),
      type: typeName ?? 'Encounter',
      periodStart: parseFlatDate(str(r, 'encounter_start_time')),
      periodEnd: parseFlatDate(str(r, 'encounter_end_time')),
      location: locationId ? facility(l.locations.get(locationId)) : undefined,
      participants: participants.length
        ? uniqueByName(participants)
        : undefined,
      reasonCodes: codes.length ? codes : undefined,
      source: DataSource.PARTICLE,
    };
  }

  private coverage(r: FlatRow, l: Lookups): CoverageDto {
    const payorId = str(r, 'payor_reference');
    const payor = payorId ? l.organizations.get(payorId) : undefined;
    return {
      id: str(r, 'coverage_id'),
      status: (str(r, 'status') ?? 'unknown').toLowerCase(),
      type: str(r, 'type_display') ?? str(r, 'type_code'),
      subscriberId: str(r, 'subscriber_id') ?? str(r, 'identifier_value'),
      relationship: str(r, 'relationship_display'),
      payor: payor ? str(payor, 'organization_name') : undefined,
      planName: str(r, 'class_value'),
      source: DataSource.PARTICLE,
    };
  }

  private familyHistory(r: FlatRow): FamilyHistoryDto | undefined {
    const id = str(r, 'family_member_history_id');
    const conditionDisplay = str(r, 'family_member_history_condition_display');
    if (!id || !conditionDisplay) return undefined;
    const code = pairCodes(
      str(r, 'family_member_history_condition_code'),
      str(r, 'family_member_history_condition_code_system'),
    )[0];
    return {
      id,
      relationship:
        str(r, 'family_member_history_relationship_display') ??
        str(r, 'family_member_history_relationship_code') ??
        'Unknown',
      relationshipCode: str(r, 'family_member_history_relationship_code'),
      sex:
        str(r, 'family_member_history_sex_display') ??
        str(r, 'family_member_history_sex_code'),
      conditions: [{ display: conditionDisplay, code }],
      source: DataSource.PARTICLE,
    };
  }

  private socialHistory(r: FlatRow): SocialHistoryDto | undefined {
    const id = str(r, 'social_history_observation_id');
    const display = str(r, 'social_history_observation_name');
    if (!id || !display) return undefined;
    const codes = withNormalisedCodes(
      pairCodes(
        str(r, 'social_history_observation_code'),
        str(r, 'social_history_observation_code_system'),
      ),
      r,
      [
        {
          column: 'social_history_observation_code_loinc',
          system: SYSTEMS.LOINC,
        },
      ],
    );
    return {
      id,
      display,
      code: preferCode(codes, [SYSTEMS.LOINC, SYSTEMS.SNOMED]),
      codes,
      value:
        str(r, 'social_history_observation_value') ??
        str(r, 'social_history_observation_value_code') ??
        '',
      effectiveDate: parseFlatDate(
        str(r, 'social_history_observation_timestamp'),
      ),
      source: DataSource.PARTICLE,
    };
  }

  private note(r: FlatRow): ClinicalNoteDto | undefined {
    const raw = str(r, 'document_reference_content_data');
    const contentType = (
      str(r, 'document_reference_content_type') ?? ''
    ).toLowerCase();
    const noteText =
      raw && (raw.includes('<') || contentType.includes('xml'))
        ? xmlToText(raw)
        : raw;
    if (!noteText) return undefined;
    const docType = str(r, 'document_reference_type');
    const rule = NOTE_TYPE_RULES.find((x) => docType && x.match.test(docType));
    return {
      id: str(r, 'document_reference_id'),
      noteText: docType ? `${docType}: ${noteText}` : noteText,
      noteType: rule?.type ?? NoteType.GENERAL,
      noteDate: parseFlatDate(str(r, 'last_updated')),
      encounterId: str(r, 'encounter_reference_id'),
      source: DataSource.PARTICLE,
    };
  }

  /* ----------------------------- extras ----------------------------- */

  /** Demographic columns on the Transitions table (name, dob, address, phone) are deliberately dropped: minimum necessary. */
  private transition(r: FlatRow): ParticleTransitionDto {
    const diag = (codeCol: string, sysCol: string, descCol: string) => {
      const codes = pairCodes(str(r, codeCol), str(r, sysCol));
      const descs = splitList(str(r, descCol), /\s*[|]\s*|\s*,\s*/);
      const n = Math.max(codes.length, descs.length);
      return Array.from({ length: n }, (_, i) => ({
        code: codes[i],
        description: descs[i],
      }));
    };
    const attendingName = str(r, 'attending_physician_name');
    return {
      id: str(r, 'transition_id') ?? 'unknown',
      visitId: str(r, 'visit_id'),
      status: str(r, 'status')?.toLowerCase(),
      setting: str(r, 'setting'),
      facilityName: str(r, 'facility_name'),
      facilityNpi: str(r, 'facility_npi'),
      facilityType: str(r, 'facility_type'),
      statusDateTime: parseFlatDate(str(r, 'status_date_time')),
      visitStart: parseFlatDate(str(r, 'visit_start_date_time')),
      visitEnd: parseFlatDate(str(r, 'visit_end_date_time')),
      attendingPhysician: attendingName
        ? { name: attendingName, npi: str(r, 'attending_physician_npi') }
        : undefined,
      admittingDiagnoses: diag(
        'admitting_diagnosis_code',
        'admitting_diagnosis_code_system',
        'admitting_diagnosis_description',
      ),
      dischargeDiagnoses: diag(
        'discharge_diagnosis_code',
        'discharge_diagnosis_code_system',
        'discharge_diagnosis_description',
      ),
      dischargeDisposition: str(r, 'discharge_disposition'),
      dischargeSummary: str(r, 'discharge_summary'),
      possibleObservationStay:
        str(r, 'possible_observation_stays') === 'true' ? true : undefined,
    };
  }

  private aiOutputs(
    outputs: FlatRow[],
    citations: FlatRow[],
  ): ParticleAiOutputDto[] {
    const byOutput = new Map<string, FlatRow[]>();
    for (const c of citations) {
      const id = str(c, 'ai_output_id');
      if (!id) continue;
      const list = byOutput.get(id) ?? [];
      list.push(c);
      byOutput.set(id, list);
    }
    return uniqueBy(outputs, 'ai_output_id').map((o) => {
      const id = str(o, 'ai_output_id') as string;
      return {
        id,
        type: str(o, 'type') ?? 'UNKNOWN',
        text: str(o, 'text'),
        createdAt: parseFlatDate(str(o, 'created')),
        resourceReferenceIds: splitList(
          str(o, 'resource_reference_ids'),
          /\s*,\s*/,
        ),
        citations: (byOutput.get(id) ?? []).map((c) => ({
          id: str(c, 'citation_id') ?? '',
          resourceType: str(c, 'resource_type'),
          resourceReferenceId: str(c, 'resource_reference_id'),
          documentReferenceId: str(c, 'preferred_document_reference_id'),
          textSnippet: str(c, 'text_snippet'),
        })),
        isAiGenerated: true as const,
      };
    });
  }
}

/* ----------------------------- mapping tables ----------------------------- */

export function mapConditionStatus(raw: string | undefined): ClinicalStatus {
  switch ((raw ?? '').toLowerCase()) {
    case 'active':
      return ClinicalStatus.ACTIVE;
    case 'resolved':
      return ClinicalStatus.RESOLVED;
    case 'inactive':
    case 'remission':
      return ClinicalStatus.INACTIVE;
    case 'recurrence':
    case 'relapse':
      return ClinicalStatus.RECURRENCE;
    default:
      return ClinicalStatus.UNKNOWN;
  }
}

/** Same defaults as the main app's FHIR parser (fhir-parser.service.ts ~L382): unknown -> ACTIVE. */
export function mapMedicationStatus(raw: string | undefined): MedicationStatus {
  switch ((raw ?? '').toLowerCase()) {
    case 'completed':
      return MedicationStatus.COMPLETED;
    case 'stopped':
      return MedicationStatus.STOPPED;
    case 'on-hold':
    case 'on_hold':
    case 'intended':
      return MedicationStatus.ON_HOLD;
    case 'discontinued':
    case 'entered-in-error':
    case 'cancelled':
      return MedicationStatus.DISCONTINUED;
    default:
      return MedicationStatus.ACTIVE;
  }
}

export function mapLabStatus(
  interpretation: string | undefined,
): LabResultStatus {
  const v = (interpretation ?? '').trim().toLowerCase();
  if (!v || v === 'n' || v === 'normal') return LabResultStatus.NORMAL;
  if (v === 'hh' || v === 'll' || v.includes('critical') || v.includes('panic'))
    return LabResultStatus.CRITICAL;
  if (v === 'h' || v.includes('high') || v.includes('elevated') || v === '>')
    return LabResultStatus.ELEVATED;
  if (v === 'l' || v.includes('low') || v === '<') return LabResultStatus.LOW;
  if (v === 'a' || v === 'aa' || v.includes('abnormal'))
    return LabResultStatus.ABNORMAL;
  return LabResultStatus.NORMAL;
}

/* ----------------------------- small helpers ----------------------------- */

function isDefined<T>(v: T | undefined): v is T {
  return v !== undefined;
}

function uniqueBy(rows: FlatRow[], key: string): FlatRow[] {
  const seen = new Set<string>();
  const out: FlatRow[] = [];
  for (const row of rows) {
    const id = str(row, key);
    if (id) {
      if (seen.has(id)) continue;
      seen.add(id);
    }
    out.push(row);
  }
  return out;
}

function preferCode(codes: CodeDto[], order: string[]): CodeDto | undefined {
  for (const system of order) {
    const hit = codes.find((c) => c.system === system);
    if (hit) return hit;
  }
  return codes[0];
}

function practitioner(
  l: Lookups,
  roleId: string | undefined,
): PractitionerDto | undefined {
  if (!roleId) return undefined;
  const p = l.practitionersByRole.get(roleId);
  if (!p) return undefined;
  const name = [
    str(p, 'practitioner_given_name'),
    str(p, 'practitioner_family_name'),
    str(p, 'practitioner_name_suffix'),
  ]
    .filter(Boolean)
    .join(' ');
  if (!name) return undefined;
  const systems = splitList(
    str(p, 'practitioner_identifier_system'),
    /\s*,\s*/,
  );
  const values = splitList(str(p, 'practitioner_identifier_value'), /\s*,\s*/);
  const npiIdx = systems.findIndex(
    (s) => s.includes('2.16.840.1.113883.4.6') || /npi/i.test(s),
  );
  const npi =
    npiIdx >= 0 ? values[npiIdx] : values.find((v) => /^\d{10}$/.test(v));
  return { name, npi, specialty: str(p, 'practitioner_role_specialty') };
}

function facility(row: FlatRow | undefined): FacilityDto | undefined {
  if (!row) return undefined;
  const name = str(row, 'location_name');
  if (!name) return undefined;
  const address = [
    str(row, 'location_address'),
    str(row, 'location_city'),
    str(row, 'location_state'),
    str(row, 'location_postal_code'),
  ]
    .filter(Boolean)
    .join(', ');
  return {
    name,
    address: address || undefined,
    type: str(row, 'location_type'),
  };
}

function uniqueByName(list: PractitionerDto[]): PractitionerDto[] {
  const seen = new Set<string>();
  return list.filter((p) =>
    seen.has(p.name) ? false : (seen.add(p.name), true),
  );
}
