// COPIED unchanged from redox-backend-nest/src/services/fhir-parser.service.ts (develop @ 33940f9) so the POC
// parses Particle FHIR with the main app's real parser. On merge: delete this copy.

import { Injectable, Logger } from '@nestjs/common';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  RedoxParsedData,
  EncounterDto,
  FacilityDto,
  PractitionerDto,
  DataSource,
  NoteType,
  ConditionDto,
  ClinicalStatus,
  ConditionSeverity,
  CodeDto,
  MedicationDto,
  MedicationStatus,
  ReferenceDto,
  LabResultDto,
  LabResultStatus,
  ReferenceRangeDto,
  VitalDto,
  VitalStatus,
  ClinicalNoteDto,
  AllergyDto,
  AllergyReactionDto,
  AllergySeverity,
  AllergyStatus,
  AllergyCriticality,
  ImmunizationDto,
  ImmunizationStatus,
  ImagingResultDto,
  ImagingStatus,
  CoverageDto,
  ProcedureDto,
  ProcedureStatus,
  FamilyHistoryDto,
  FamilyHistoryConditionDto,
  SocialHistoryDto,
  CarePlanDto,
  CarePlanActivityDto,
} from '../types/clinical.types';
import {
  lookupMedicationBodySystem,
  lookupLabBodySystem,
} from './body-system-lookup';

@Injectable()
export class FhirParserService {
  private readonly logger = new Logger(FhirParserService.name);

  private parseDate(v: any): Date | undefined {
    if (!v) return undefined;
    try {
      const d = new Date(v);
      return isNaN(d.getTime()) ? undefined : d;
    } catch {
      return undefined;
    }
  }

  /**
   * Intelligently decodes base64 data. FHIR spec requires Attachment.data (and similar fields) to be base64 encoded.
   */
  private decodeBase64Intelligently(data: string | undefined): string | undefined {
    if (!data) return undefined;
    try {
      // Decode base64 string to utf8
      const decoded = Buffer.from(data, 'base64').toString('utf8');
      return decoded.trim();
    } catch {
      return data; // Fallback to raw if decoding fails
    }
  }

  /**
   * Helper to extract the most relevant terminology code from a FHIR CodeableConcept.
   * Prioritizes standard systems like LOINC, SNOMED, RxNorm.
   */
  /**
   * Returns EVERY usable coding on a CodeableConcept as {system, value} pairs,
   * deduped, skipping empty/placeholder ("0") codes. Unlike extractCode (which
   * collapses to one priority-ordered code), this preserves ICD-9/ICD-10
   * alongside SNOMED so downstream code-based grouping isn't starved of the ICD
   * codes.
   */
  private extractAllCodes(codeObj: any): CodeDto[] {
    if (!codeObj || !Array.isArray(codeObj.coding)) return [];
    const out: CodeDto[] = [];
    const seen = new Set<string>();
    for (const c of codeObj.coding) {
      const system = (c?.system ?? '').toString().trim();
      const value = (c?.code ?? '').toString().trim();
      if (!value || value === '0') continue;
      const key = `${system.toLowerCase()}|${value.toLowerCase()}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ system: system || 'unknown', value });
    }
    return out;
  }

  private extractCode(codeObj: any): CodeDto {
    if (!codeObj || !codeObj.coding || !Array.isArray(codeObj.coding)) {
      return { system: 'unknown', value: 'unknown' };
    }

    const codings = codeObj.coding;
    // Priority systems
    const priorities = [
      'loinc.org',
      'snomed.info',
      'rxnorm',
      'icd-10',
      'icd-9',
      'urn:oid:2.16.840.1.113883.6.96', // SNOMED OID
      'urn:oid:2.16.840.1.113883.6.1',  // LOINC OID
    ];

    for (const sys of priorities) {
      const found = codings.find((c: any) =>
        (c.system || '').toLowerCase().includes(sys),
      );
      if (found && found.code) {
        return { system: found.system, value: found.code };
      }
    }

    // Fallback to first available coding that has a code
    const firstWithCode = codings.find((c: any) => c.code);
    if (firstWithCode) {
      return {
        system: firstWithCode.system || 'unknown',
        value: firstWithCode.code,
      };
    }

    return { system: 'unknown', value: 'unknown' };
  }

  /**
   * Helper to find the most accurate "recorded" date for a clinical resource.
   * Avoids using current server time where medical timestamps are available.
   */
  private getResourceDate(res: any): Date {
    const rawDate =
      res.authoredOn ||
      res.effectiveDateTime ||
      res.effectivePeriod?.start ||
      res.recordedDate ||
      res.occurrenceDateTime ||
      res.date ||
      res.issued ||
      res.period?.start;

    return this.parseDate(rawDate) || new Date();
  }

  private getContextualReasons(
    encounterRef: string | undefined,
    map: Map<string, CodeDto[]>,
  ): CodeDto[] | undefined {
    if (!encounterRef) return undefined;
    const cleanId = encounterRef.split('/').pop();
    return cleanId ? map.get(cleanId) : undefined;
  }

  private getEncounterId(encounterRef: string | undefined): string | undefined {
    if (!encounterRef) return undefined;
    return encounterRef.split('/').pop();
  }

  /**
   * Builds a `<resourceId> -> display name` index over Practitioner and
   * Organization resources.
   *
   * Metriport emits `performer`/`participant` as bare references with no inline
   * `display`, so without this index every practitioner and facility name comes
   * out as 'Unknown'.
   *
   * @param bundles - bundles whose entries may hold Practitioner/Organization
   * @returns map keyed by resource id; empty when no such resources are present
   */
  private buildActorIndex(...bundles: any[]): Map<string, string> {
    const index = new Map<string, string>();
    for (const bundle of bundles) {
      for (const entry of bundle?.entry || []) {
        const res = entry?.resource;
        if (!res?.id) continue;
        if (res.resourceType === 'Practitioner') {
          const name = this.formatHumanName(res.name?.[0]);
          if (name) index.set(res.id, name);
        } else if (res.resourceType === 'Organization') {
          if (res.name) index.set(res.id, res.name);
        }
      }
    }
    return index;
  }

  /** Renders a FHIR HumanName as "Prefix Given Family Suffix". */
  private formatHumanName(name: any): string | undefined {
    if (!name) return undefined;
    if (name.text) return name.text;
    const parts = [
      ...(name.prefix || []),
      ...(name.given || []),
      name.family,
      ...(name.suffix || []),
    ].filter(Boolean);
    return parts.length ? parts.join(' ') : undefined;
  }

  /**
   * Resolves a FHIR Reference to a human-readable name, preferring the inline
   * `display` and falling back to the actor index.
   */
  private resolveActorName(
    ref: any,
    actorIndex: Map<string, string>,
  ): string | undefined {
    if (!ref) return undefined;
    if (ref.display) return ref.display;
    const id = ref.reference?.split('/').pop();
    return id ? actorIndex.get(id) : undefined;
  }

  /** Comma-joined text of a CodeableConcept array (e.g. bodySite, category). */
  private codeableConceptText(list: any): string | undefined {
    const arr = Array.isArray(list) ? list : list ? [list] : [];
    const parts = arr
      .map((c: any) => c?.text || c?.coding?.[0]?.display)
      .filter(Boolean);
    return parts.length ? parts.join(', ') : undefined;
  }

  /** Renders a FHIR Quantity as "<value> <unit>", or undefined when unusable. */
  private formatQuantity(q: any): string | undefined {
    if (!q || q.value === undefined || q.value === null) return undefined;
    const unit = q.unit || q.code;
    return unit ? `${q.value} ${unit}` : String(q.value);
  }

  private parseConditions(bundle: any, source: DataSource): ConditionDto[] {
    const dtos: ConditionDto[] = [];
    const entries = bundle.entry || [];
    for (const entry of entries) {
      const res = entry.resource;
      if (!res || res.resourceType !== 'Condition') continue;
      try {
        const rid = res.id;
        const clStatusArr = res.clinicalStatus || {};
        const clCode = clStatusArr.coding?.[0]?.code;

        // CareEvolution and other Fasten partners often use a 'data-absent-reason' extension
        // to explicitly mark clinical data as 'unknown' rather than using a standard code.
        const statusExtension = clStatusArr.extension?.find(
          (e: any) =>
            e.url ===
            'http://hl7.org/fhir/StructureDefinition/data-absent-reason',
        );
        const absentReason = statusExtension?.valueCode;

        let status = ClinicalStatus.ACTIVE;
        // Map raw strings or coded status to our common ClinicalStatus enum.
        if (
          ['active', 'recurrence', 'relapse'].includes(clCode) ||
          res.clinicalStatus === 'active'
        )
          status = ClinicalStatus.ACTIVE;
        else if (['resolved', 'remission'].includes(clCode))
          status = ClinicalStatus.RESOLVED;
        else if (['inactive'].includes(clCode))
          status = ClinicalStatus.INACTIVE;
        else if (clCode === 'unknown' || absentReason === 'unknown')
          status = ClinicalStatus.UNKNOWN;

        const codeObj = res.code || {};
        const display =
          codeObj.text ||
          codeObj.coding?.[0]?.display ||
          'Unknown Condition';

        const codeDto = this.extractCode(codeObj);

        const sevCoding = res.severity?.coding?.[0] || {};
        const sevStr = JSON.stringify(sevCoding).toLowerCase();
        let sev: ConditionSeverity | undefined;
        if (sevStr.includes('severe')) sev = ConditionSeverity.HIGH;
        else if (sevStr.includes('moderate')) sev = ConditionSeverity.MODERATE;
        else if (sevStr.includes('mild')) sev = ConditionSeverity.LOW;

        const onset = res.onsetDateTime || res.onsetPeriod?.start || res.recordedDate;
        const resolved = res.abatementDateTime || res.abatementPeriod?.end || res.onsetPeriod?.end;

        // Practitioner name extraction for full DTO coverage.
        const asserter = res.asserter?.display
          ? { name: res.asserter.display }
          : undefined;

        dtos.push({
          id: rid,
          display,
          code: codeDto,
          codes: this.extractAllCodes(codeObj),
          clinicalStatus: status,
          severity: sev,
          onsetDate: this.parseDate(onset),
          resolvedDate: this.parseDate(resolved), // New DTO field: Track when/if condition was resolved
          asserter: asserter, // New DTO field: Track which practitioner asserted the condition
          encounterReference: res.encounter?.reference, // New DTO field: Link condition back to encounter
          encounterId: this.getEncounterId(res.encounter?.reference),
          source,
          recordedAt: this.getResourceDate(res),
        });
      } catch (e) {
        this.logger.error(
          `Error parsing FHIR Condition ${res.id}: ${e.message}`,
        );
      }
    }
    return dtos;
  }

  private parseMedications(
    reqBundle: any,
    medBundle: any,
    source: DataSource,
    encounterReasonMap: Map<string, CodeDto[]>,
  ): MedicationDto[] {
    const dtos: MedicationDto[] = [];
    const entries = reqBundle.entry || [];

    // Create a map of Medication resources for fast reference lookups
    const medsMap = new Map<string, any>();
    (medBundle.entry || []).forEach((e: any) => {
      const mRes = e.resource;
      if (mRes?.resourceType === 'Medication' && mRes.id) {
        medsMap.set(mRes.id, mRes);
      }
    });

    for (const entry of entries) {
      const res = entry.resource;
      // MedicationStatement is the primary medication resource on some networks
      // (Metriport returns ~3x more of them than MedicationRequest), so both
      // must be accepted or most of the med list is silently dropped.
      if (
        !res ||
        (res.resourceType !== 'MedicationRequest' &&
          res.resourceType !== 'MedicationStatement')
      )
        continue;
      const isStatement = res.resourceType === 'MedicationStatement';
      try {
        const rid = res.id;
        const medCC = res.medicationCodeableConcept;
        const medRef = res.medicationReference;

        let display = 'Unknown Medication';
        let codeDto = { system: 'unknown', value: 'unknown' };

        if (medCC) {
          display =
            medCC.text || medCC.coding?.[0]?.display || 'Unknown Medication';
          codeDto = this.extractCode(medCC);
        } else if (medRef) {
          display = medRef.display || 'Unknown Medication';
          const refId = medRef.reference?.split('/')?.pop();
          const linkedMed = medsMap.get(refId);
          if (linkedMed) {
            codeDto = this.extractCode(linkedMed.code);
            if (display === 'Unknown Medication' || !display) {
              display =
                linkedMed.code?.text ||
                linkedMed.code?.coding?.[0]?.display ||
                display;
            }
          }
        }

        const rawStat = res.status;
        let status = MedicationStatus.ACTIVE;
        if (rawStat === 'active') status = MedicationStatus.ACTIVE;
        else if (rawStat === 'completed') status = MedicationStatus.COMPLETED;
        else if (rawStat === 'stopped') status = MedicationStatus.STOPPED;
        else if (['entered-in-error', 'cancelled'].includes(rawStat))
          status = MedicationStatus.DISCONTINUED;
        else if (rawStat === 'on-hold') status = MedicationStatus.ON_HOLD;
        // MedicationStatement-only statuses (R4 medication-statement-status).
        else if (['not-taken', 'stopped-by-patient'].includes(rawStat))
          status = MedicationStatus.DISCONTINUED;
        else if (rawStat === 'intended') status = MedicationStatus.ON_HOLD;

        // MedicationRequest carries `dosageInstruction`; MedicationStatement
        // carries `dosage`. Same Dosage datatype, different field name.
        const dosages =
          (isStatement ? res.dosage : res.dosageInstruction) || [];
        const dosageFirst = dosages[0] || {};
        // Fall back to the structured dose when the source omits free text —
        // MedicationStatement rarely populates `text`.
        const dosageStr =
          dosageFirst.text ||
          this.formatQuantity(dosageFirst.doseAndRate?.[0]?.doseQuantity);

        const timingRepeat = dosageFirst.timing?.repeat || {};
        const frequencyNumber = timingRepeat.frequency;
        const period = timingRepeat.period;
        const periodUnit = timingRepeat.periodUnit;

        const route = dosageFirst.route?.text || dosageFirst.route?.coding?.[0]?.display;

        // Expanded mapping for frequency and duration to align with MedicationDto
        const frequency = period
          ? `${period} per ${periodUnit || 'unit'}`
          : undefined;

        let startDate =
          timingRepeat.boundsPeriod?.start ||
          (isStatement
            ? res.effectivePeriod?.start || res.effectiveDateTime
            : res.authoredOn);
        let endDate =
          timingRepeat.boundsPeriod?.end ||
          (isStatement ? res.effectivePeriod?.end : undefined);

        // Fallback to dispenseRequest validityPeriod if timing bounds are missing
        if (!startDate || !endDate) {
          const validity = res.dispenseRequest?.validityPeriod || {};
          if (!startDate) startDate = validity.start;
          if (!endDate) endDate = validity.end;
        }

        const encounterRef =
          res.encounter?.reference ?? res.context?.reference;

        dtos.push({
          id: rid,
          display,
          code: codeDto,
          body_system: lookupMedicationBodySystem(display),
          dosage: dosageStr,
          frequency,
          frequencyNumber,
          period,
          periodUnit,
          route,
          status,
          startDate: this.parseDate(startDate),
          endDate: this.parseDate(endDate),
          // MedicationStatement records the attributor as `informationSource`.
          requester: (res.requester ?? res.informationSource)?.display
            ? { name: (res.requester ?? res.informationSource).display }
            : undefined,
          reasonReference: res.reasonReference?.map((ref: any) => ({
            reference: ref.reference,
            display: ref.display,
          })),
          // reasonCodes: res.reasonCode?.map((rc: any) => this.extractCode(rc)),
          // MedicationStatement names the encounter link `context`, not `encounter`.
          encounterReference: encounterRef,
          encounterId: this.getEncounterId(encounterRef),
          /* contextualReasonCodes: this.getContextualReasons(
            res.encounter?.reference,
            encounterReasonMap,
          ), */
          source,
          recordedAt: this.getResourceDate(res),
        });
      } catch (e) {
        this.logger.error(
          `Error parsing FHIR Medication ${res.id}: ${e.message}`,
        );
      }
    }
    return dtos;
  }

  private parseAllergies(
    bundle: any,
    source: DataSource,
    encounterReasonMap: Map<string, CodeDto[]>,
  ): AllergyDto[] {
    const dtos: AllergyDto[] = [];
    const entries = bundle.entry || [];
    for (const entry of entries) {
      const res = entry.resource;
      if (!res || res.resourceType !== 'AllergyIntolerance') continue;
      try {
        const rid = res.id;
        const codeObj = res.code || {};
        const display =
          codeObj.text || codeObj.coding?.[0]?.display || 'Unknown Allergen';

        const clStatus = res.clinicalStatus || {};
        const clCode = clStatus.coding?.[0]?.code;
        let status = AllergyStatus.ACTIVE;
        if (clCode === 'active' || res.clinicalStatus === 'active')
          status = AllergyStatus.ACTIVE;
        else if (clCode === 'inactive') status = AllergyStatus.INACTIVE;
        else if (clCode === 'resolved') status = AllergyStatus.RESOLVED;

        // Extract the full reactions array per FHIR AllergyIntolerance.reaction
        const reactions: AllergyReactionDto[] = [];
        if (Array.isArray(res.reaction)) {
          for (const r of res.reaction) {
            const manifestations: string[] = [];
            if (Array.isArray(r.manifestation)) {
              for (const m of r.manifestation) {
                // Prefer the coded display when `text` is a placeholder, so a
                // real manifestation isn't masked by a literal "unknown".
                const coded = m.coding?.[0]?.display;
                const txt =
                  !m.text || m.text.toLowerCase() === 'unknown'
                    ? coded || m.text
                    : m.text;
                if (txt) manifestations.push(txt);
              }
            }

            let rSeverity: AllergySeverity | undefined;
            if (r.severity === 'mild') rSeverity = AllergySeverity.MILD;
            else if (r.severity === 'moderate') rSeverity = AllergySeverity.MODERATE;
            else if (r.severity === 'severe') rSeverity = AllergySeverity.SEVERE;

            reactions.push({
              substance: r.substance?.text || r.substance?.coding?.[0]?.display,
              manifestations,
              severity: rSeverity,
              description: r.description,
            });
          }
        }

        // Backwards-compatible flat fields from the first reaction. Fall back to
        // the manifestation coding: sources frequently set `text` to a literal
        // "unknown" while carrying a real coded manifestation alongside it.
        const firstManifestation = res.reaction?.[0]?.manifestation?.[0];
        const manifestationText = firstManifestation?.text;
        const manifestationCoded = firstManifestation?.coding?.[0]?.display;
        const reaction =
          !manifestationText || manifestationText.toLowerCase() === 'unknown'
            ? manifestationCoded || manifestationText
            : manifestationText;
        const severityStr = res.reaction?.[0]?.severity;
        let severity: AllergySeverity | undefined;
        if (severityStr === 'mild') severity = AllergySeverity.MILD;
        else if (severityStr === 'moderate') severity = AllergySeverity.MODERATE;
        else if (severityStr === 'severe') severity = AllergySeverity.SEVERE;

        let criticality: AllergyCriticality | undefined;
        if (res.criticality === 'low') criticality = AllergyCriticality.LOW;
        else if (res.criticality === 'high') criticality = AllergyCriticality.HIGH;
        else if (res.criticality === 'unable-to-assess')
          criticality = AllergyCriticality.UNABLE_TO_ASSESS;

        dtos.push({
          id: rid,
          display,
          code: this.extractCode(codeObj),
          codes: this.extractAllCodes(codeObj),
          reaction,
          reactions: reactions.length > 0 ? reactions : undefined,
          severity,
          criticality,
          allergyType: res.type,
          categories: Array.isArray(res.category) ? res.category : undefined,
          onsetDate: this.parseDate(
            res.onsetDateTime || res.onsetPeriod?.start || res.recordedDate,
          ),
          status,
          asserter: res.recorder?.display
            ? { name: res.recorder.display }
            : undefined,
          encounterReference: res.encounter?.reference,
          encounterId: this.getEncounterId(res.encounter?.reference),
          /* contextualReasonCodes: this.getContextualReasons(
            res.encounter?.reference,
            encounterReasonMap,
          ), */
          reasonReference: res.reasonReference?.map((ref: any) => ({
            reference: ref.reference,
            display: ref.display,
          })),
          source,
          recordedAt: this.getResourceDate(res),
        });
      } catch (e) {
        this.logger.error(`Error parsing FHIR Allergy ${res.id}: ${e.message}`);
      }
    }
    return dtos;
  }

  private parseVitals(
    bundle: any,
    source: DataSource,
    encounterReasonMap: Map<string, CodeDto[]>,
  ): VitalDto[] {
    const dtos: VitalDto[] = [];
    const entries = bundle.entry || [];
    for (const entry of entries) {
      const res = entry.resource;
      if (!res || res.resourceType !== 'Observation') continue;

      const isVital = (res.category || []).some((cat: any) =>
        (cat.coding || []).some((c: any) => c.code === 'vital-signs'),
      );
      if (!isVital) continue;

      try {
        const rid = res.id;
        const codeObj = res.code || {};
        const display =
          codeObj.text || codeObj.coding?.[0]?.display || 'Unknown Vital';

        let valueStr: string | undefined;
        let unit: string | undefined;

        if (res.valueQuantity) {
          valueStr = String(res.valueQuantity.value);
          unit = res.valueQuantity.unit;
        } else if (res.valueString) {
          valueStr = res.valueString;
        } else if (res.valueCodeableConcept) {
          valueStr = res.valueCodeableConcept.text;
        } else if (res.component) {
          // Check for BP components standardly (using LOINC or Display names)
          const sysComp = res.component.find((c: any) => {
            const code = (c.code?.coding?.[0]?.code || '').toLowerCase();
            const text = (c.code?.text || '').toLowerCase();
            return code === '8480-6' || text.includes('systolic');
          });
          const diaComp = res.component.find((c: any) => {
            const code = (c.code?.coding?.[0]?.code || '').toLowerCase();
            const text = (c.code?.text || '').toLowerCase();
            return code === '8462-4' || text.includes('diastolic');
          });

          if (sysComp && diaComp) {
            const sysVal = sysComp.valueQuantity?.value;
            const diaVal = diaComp.valueQuantity?.value;
            unit = sysComp.valueQuantity?.unit || diaComp.valueQuantity?.unit;
            if (sysVal !== undefined && diaVal !== undefined) {
              valueStr = `${sysVal}/${diaVal}`;
            }
          }

          // Fallback if not found or structured differently
          if (!valueStr) {
            const parts = res.component.map((comp: any) => {
              const cDisplay = comp.code?.text || '';
              const cVal = comp.valueQuantity?.value ?? '?';
              const cUnit = comp.valueQuantity?.unit ?? '';
              return `${cDisplay}: ${cVal} ${cUnit}`;
            });
            valueStr = parts.join(' / ');
          }
        }

        if (!valueStr) continue;

        const effective = res.effectiveDateTime || res.effectivePeriod?.start || res.issued;
        const effectiveEnd = res.effectivePeriod?.end;
        dtos.push({
          id: rid,
          display,
          code: this.extractCode(codeObj),
          body_system: lookupLabBodySystem(display),
          interpretation: this.codeableConceptText(res.interpretation),
          value: valueStr,
          unit,
          recordedDate: this.parseDate(effective),
          recordedEndDate: this.parseDate(effectiveEnd),
          encounterReference: res.encounter?.reference,
          encounterId: this.getEncounterId(res.encounter?.reference),
          /* contextualReasonCodes: this.getContextualReasons(
            res.encounter?.reference,
            encounterReasonMap,
          ), */
          reasonReference: res.reasonReference?.map((ref: any) => ({
            reference: ref.reference,
            display: ref.display,
          })),
          basedOn: res.basedOn?.map((ref: any) => ({
            reference: ref.reference,
            display: ref.display,
          })),
          focus: res.focus?.map((ref: any) => ({
            reference: ref.reference,
            display: ref.display,
          })),
          source,
          recordedAt: this.getResourceDate(res),
        });
      } catch (e) {
        this.logger.error(`Error parsing FHIR Vital ${res.id}: ${e.message}`);
      }
    }
    return dtos;
  }

  private parseLabs(
    bundle: any,
    source: DataSource,
    encounterReasonMap: Map<string, CodeDto[]>,
  ): LabResultDto[] {
    const dtos: LabResultDto[] = [];
    const entries = bundle.entry || [];
    let skippedType = 0;
    let skippedCategory = 0;
    for (const entry of entries) {
      const res = entry.resource;
      if (!res || res.resourceType !== 'Observation') {
        skippedType++;
        continue;
      }

      const isLab = (res.category || []).some(
        (cat: any) =>
          cat.text?.toLowerCase() === 'laboratory' ||
          (cat.coding || []).some(
            (c: any) => c.code?.toLowerCase() === 'laboratory',
          ),
      );
      if (!isLab) {
        skippedCategory++;
        continue;
      }

      try {
        const rid = res.id;
        const codeObj = res.code || {};
        const display =
          codeObj.text || codeObj.coding?.[0]?.display || 'Unknown Lab';

        let valueStr: string | undefined;
        let unit: string | undefined;
        if (res.valueQuantity) {
          valueStr = String(res.valueQuantity.value);
          unit = res.valueQuantity.unit;
        } else if (res.valueString) {
          valueStr = res.valueString;
        } else if (res.valueCodeableConcept) {
          valueStr = res.valueCodeableConcept.text;
        }

        let refRange: ReferenceRangeDto | undefined;
        if (res.referenceRange?.[0]) {
          const rr = res.referenceRange[0];
          refRange = {
            low: rr.low ? String(rr.low.value) : undefined,
            high: rr.high ? String(rr.high.value) : undefined,
            unit: rr.low?.unit || rr.high?.unit,
            text: rr.text,
          };
        }

        const interp = res.interpretation?.[0];
        const interpCode = interp?.coding?.[0]?.code || '';
        let status = LabResultStatus.NORMAL;
        if (['H', 'HH'].includes(interpCode)) status = LabResultStatus.ELEVATED;
        else if (['L', 'LL'].includes(interpCode)) status = LabResultStatus.LOW;
        else if (['A', 'AA'].includes(interpCode))
          status = LabResultStatus.ABNORMAL;

        const effective = res.effectiveDateTime || res.effectivePeriod?.start || res.issued;
        const effectiveEnd = res.effectivePeriod?.end;

        dtos.push({
          id: rid,
          display,
          code: this.extractCode(codeObj),
          body_system: lookupLabBodySystem(display),
          status,
          interpretation: this.codeableConceptText(res.interpretation),
          value: valueStr,
          unit,
          referenceRange: refRange,
          effectiveDate: this.parseDate(effective),
          effectiveEndDate: this.parseDate(effectiveEnd),
          encounterReference: res.encounter?.reference,
          encounterId: this.getEncounterId(res.encounter?.reference),
          /* contextualReasonCodes: this.getContextualReasons(
            res.encounter?.reference,
            encounterReasonMap,
          ), */
          reasonReference: res.reasonReference?.map((ref: any) => ({
            reference: ref.reference,
            display: ref.display,
          })),
          basedOn: res.basedOn?.map((ref: any) => ({
            reference: ref.reference,
            display: ref.display,
          })),
          focus: res.focus?.map((ref: any) => ({
            reference: ref.reference,
            display: ref.display,
          })),
          source,
          recordedAt: this.getResourceDate(res),
        });
      } catch (e) {
        this.logger.error(`Error parsing FHIR Lab ${res.id}: ${e.message}`);
      }
    }
    if (skippedType || skippedCategory) {
      this.logger.warn(
        `parseLabs: parsed ${dtos.length}/${entries.length} observations ` +
          `(skipped ${skippedType} non-Observation, ${skippedCategory} non-laboratory category)`,
      );
    }
    return dtos;
  }

  private parseImmunizations(
    bundle: any,
    source: DataSource,
    encounterReasonMap: Map<string, CodeDto[]>,
  ): ImmunizationDto[] {
    const dtos: ImmunizationDto[] = [];
    const entries = bundle.entry || [];
    for (const entry of entries) {
      const res = entry.resource;
      if (!res || res.resourceType !== 'Immunization') continue;
      try {
        const rid = res.id;
        const display =
          res.vaccineCode?.text ||
          res.vaccineCode?.coding?.[0]?.display ||
          'Unknown Vaccine';
        const status =
          res.status === 'completed'
            ? ImmunizationStatus.COMPLETED
            : ImmunizationStatus.NOT_DONE;
        const administeredDate = this.parseDate(res.occurrenceDateTime);
        const manufacturer = res.manufacturer?.display;

        let doseNumber: number | undefined;
        let seriesDoses: number | undefined;
        const protocols = res.protocolApplied || [];
        if (protocols.length > 0) {
          const dStr =
            protocols[0].doseNumberPositiveInt || protocols[0].doseNumberString;
          if (dStr && !isNaN(Number(dStr))) doseNumber = Number(dStr);

          const sStr =
            protocols[0].seriesDosesPositiveInt || protocols[0].seriesDosesString;
          if (sStr && !isNaN(Number(sStr))) seriesDoses = Number(sStr);
        }

        const expirationDate = this.parseDate(res.expirationDate);

        const location = res.location
          ? { name: res.location.display || 'Unknown' }
          : undefined;

        dtos.push({
          id: rid,
          display,
          code: this.extractCode(res.vaccineCode),
          codes: this.extractAllCodes(res.vaccineCode),
          manufacturer,
          lotNumber: res.lotNumber,
          site: this.codeableConceptText(res.site),
          route: this.codeableConceptText(res.route),
          doseQuantity: this.formatQuantity(res.doseQuantity),
          doseNumber,
          seriesDoses,
          expirationDate,
          administeredDate,
          status,
          location,
          encounterReference: res.encounter?.reference,
          encounterId: this.getEncounterId(res.encounter?.reference),
          /* contextualReasonCodes: this.getContextualReasons(
            res.encounter?.reference,
            encounterReasonMap,
          ), */
          reasonReference: res.reasonReference?.map((ref: any) => ({
            reference: ref.reference,
            display: ref.display,
          })),
          source,
          recordedAt: this.getResourceDate(res),
        });
      } catch (e) {
        this.logger.error(`Error parsing FHIR Immunization ${res.id}: ${e.message}`);
      }
    }
    return dtos;
  }

  private parseEncounters(
    bundle: any,
    source: DataSource,
    actorIndex: Map<string, string> = new Map(),
  ): EncounterDto[] {
    const dtos: EncounterDto[] = [];
    const entries = bundle.entry || [];
    for (const entry of entries) {
      const res = entry.resource;
      if (!res || res.resourceType !== 'Encounter') continue;
      try {
        const rid = res.id;
        const encType = res.type?.[0]?.text || res.class?.display || 'unknown';

        dtos.push({
          id: rid,
          type: encType,
          classCode: res.class?.code,
          periodStart: this.parseDate(res.period?.start),
          periodEnd: this.parseDate(res.period?.end),
          location: res.location?.[0]
            ? {
                name:
                  this.resolveActorName(res.location[0].location, actorIndex) ||
                  'Unknown',
              }
            : undefined,
          participants: (res.participant || []).map((p: any) => ({
            name: this.resolveActorName(p.individual, actorIndex) || 'Unknown',
          })),
          reasonCodes: res.reasonCode?.map((rc: any) => this.extractCode(rc)),
          reasonReference: res.reasonReference?.map((ref: any) => ({
            reference: ref.reference,
            display: ref.display,
          })),
          source,
          recordedAt: this.getResourceDate(res),
        });
      } catch (e) {
        this.logger.error(`Error parsing FHIR Encounter ${res.id}: ${e.message}`);
      }
    }
    return dtos;
  }

  /**
   * Matches text naming a radiology/imaging modality. Used to recognise imaging
   * studies that arrive as Procedures or as uncategorised DiagnosticReports,
   * which is how several networks (Metriport included) deliver them.
   */
  private static readonly IMAGING_MODALITY_RE =
    /\b(x-?ray|radiograph|radiolog|imaging|ct scan|computed tomograph|mri|magnetic resonance|ultrasound|ultrasonograph|sonogram|echocardiogra|mammograph|mammogram|fluoroscop|angiograph|pet scan|nuclear medicine|dual energy x-?ray absorptiometry|dexa|bone density)\b/i;

  /** True when a CodeableConcept's text or coding displays name an imaging study. */
  private isImagingConcept(codeObj: any): boolean {
    const texts = [
      codeObj?.text,
      ...((codeObj?.coding || []) as any[]).map((c) => c?.display),
    ].filter(Boolean);
    return texts.some((t: string) =>
      FhirParserService.IMAGING_MODALITY_RE.test(t),
    );
  }

  /**
   * Best label for an imaging study's CodeableConcept.
   *
   * Prefers whichever coding actually names the modality: radiology reports are
   * routinely coded with a generic primary code (`text: 'Note'`) plus a specific
   * secondary one (e.g. "Mammogram"), and the generic text alone is useless.
   */
  private imagingScanType(codeObj: any): string {
    const candidates = [
      ...((codeObj?.coding || []) as any[]).map((c) => c?.display),
      codeObj?.text,
    ].filter(Boolean);
    const modality = candidates.find((t: string) =>
      FhirParserService.IMAGING_MODALITY_RE.test(t),
    );
    return modality || codeObj?.text || candidates[0] || 'Unknown Imaging';
  }

  private parseImaging(
    bundle: any,
    source: DataSource,
    encounterReasonMap: Map<string, CodeDto[]>,
    procedureBundle: any = { entry: [] },
    actorIndex: Map<string, string> = new Map(),
  ): ImagingResultDto[] {
    const dtos: ImagingResultDto[] = [];
    const entries = bundle.entry || [];
    for (const entry of entries) {
      const res = entry.resource;
      if (!res || res.resourceType !== 'DiagnosticReport') continue;

      // A radiology category is the reliable signal, but many sources omit
      // `category` entirely — fall back to recognising the modality in the code.
      const isRadiology =
        (res.category || []).some(
          (cat: any) =>
            cat.text?.toLowerCase() === 'radiology' ||
            (cat.coding || []).some((c: any) => c.code === 'LP29684-5'),
        ) || this.isImagingConcept(res.code);
      if (!isRadiology) continue;

      try {
        const rid = res.id;
        const status =
          res.status === 'final' ? ImagingStatus.NORMAL : ImagingStatus.PENDING;
        const effective = res.effectiveDateTime || res.effectivePeriod?.start;
        const effectiveEnd = res.effectivePeriod?.end;

        dtos.push({
          id: rid,
          scanType: this.imagingScanType(res.code),
          code: this.extractCode(res.code),
          bodyPart: this.codeableConceptText(res.bodySite),
          // The report narrative lives in presentedForm. These reports are no
          // longer emitted as notes, so decode it here or the text is lost.
          findings:
            this.decodeBase64Intelligently(res.presentedForm?.[0]?.data) ||
            res.conclusion,
          status,
          performedDate: this.parseDate(effective),
          performedEndDate: this.parseDate(effectiveEnd),
          performer: res.performer?.[0]
            ? { name: res.performer[0].display || 'Unknown' }
            : undefined,
          encounterReference: res.encounter?.reference,
          encounterId: this.getEncounterId(res.encounter?.reference),
          /* contextualReasonCodes: this.getContextualReasons(
            res.encounter?.reference,
            encounterReasonMap,
          ), */
          reasonReference: res.reasonReference?.map((ref: any) => ({
            reference: ref.reference,
            display: ref.display,
          })),
          basedOn: res.basedOn?.map((ref: any) => ({
            reference: ref.reference,
            display: ref.display,
          })),
          source,
          recordedAt: this.getResourceDate(res),
        });
      } catch (e) {
        this.logger.error(`Error parsing FHIR Imaging ${res.id}: ${e.message}`);
      }
    }

    // Several networks deliver imaging studies only as Procedure resources and
    // never as a radiology DiagnosticReport, which left this domain permanently
    // empty. Project those Procedures in so the imaging list is populated.
    // They intentionally REMAIN in `procedures` too — `derivedFromProcedureId`
    // marks the projection so consumers reading both domains can skip them.
    const seenIds = new Set(dtos.map((d) => d.id));
    for (const entry of procedureBundle?.entry || []) {
      const res = entry?.resource;
      if (!res || res.resourceType !== 'Procedure') continue;
      if (!this.isImagingConcept(res.code)) continue;
      if (seenIds.has(res.id)) continue;

      try {
        const performerName = this.resolveActorName(
          res.performer?.[0]?.actor,
          actorIndex,
        );
        dtos.push({
          id: res.id,
          scanType: this.imagingScanType(res.code),
          code: this.extractCode(res.code),
          bodyPart: this.codeableConceptText(res.bodySite),
          status:
            res.status === 'completed'
              ? ImagingStatus.NORMAL
              : ImagingStatus.PENDING,
          performedDate: this.parseDate(
            res.performedDateTime || res.performedPeriod?.start,
          ),
          performedEndDate: this.parseDate(res.performedPeriod?.end),
          performer: performerName ? { name: performerName } : undefined,
          derivedFromProcedureId: res.id,
          encounterReference: res.encounter?.reference,
          encounterId: this.getEncounterId(res.encounter?.reference),
          reasonReference: res.reasonReference?.map((ref: any) => ({
            reference: ref.reference,
            display: ref.display,
          })),
          source,
          recordedAt: this.getResourceDate(res),
        });
        seenIds.add(res.id);
      } catch (e) {
        this.logger.error(
          `Error deriving imaging from FHIR Procedure ${res?.id}: ${e.message}`,
        );
      }
    }
    return dtos;
  }

  private parseNotes(
    diagBundle: any,
    docRefBundle: any,
    source: DataSource,
    encounterReasonMap: Map<string, CodeDto[]>,
  ): ClinicalNoteDto[] {
    const dtos: ClinicalNoteDto[] = [];
    const seenIds = new Set<string>();

    const diagEntries = diagBundle.entry || [];
    let skippedResultContainers = 0;
    for (const entry of diagEntries) {
      const res = entry.resource;
      if (!res || res.resourceType !== 'DiagnosticReport') continue;

      const isRadiology =
        (res.category || []).some(
          (cat: any) =>
            cat.text?.toLowerCase() === 'radiology' ||
            (cat.coding || []).some((c: any) => c.code === 'LP29684-5'),
        ) || this.isImagingConcept(res.code);
      if (isRadiology) continue;

      // Lab-panel DiagnosticReports are containers that point at Observations
      // via `result` — the values are already parsed into `labs`. Without this
      // they land in `notes` as content-free rows. Only skip when there is no
      // narrative attached, so a report carrying real text is never lost.
      const hasNarrative = !!res.presentedForm?.[0]?.data;
      const isResultContainer = (res.category || []).some(
        (cat: any) =>
          /relevant diagnostic tests|laboratory/i.test(cat.text || '') ||
          (cat.coding || []).some((c: any) => c.code === '30954-2'),
      );
      if (isResultContainer && !hasNarrative) {
        skippedResultContainers++;
        continue;
      }

      try {
        const rid = res.id;
        if (seenIds.has(rid)) continue;
        seenIds.add(rid);

        const title = res.code?.text || res.code?.coding?.[0]?.display || 'Clinical Report';
        const formTitle = res.presentedForm?.[0]?.title || title;
        const effective = res.effectiveDateTime || res.effectivePeriod?.start;
        const author = res.performer?.[0]
          ? { name: res.performer[0].display || 'Unknown' }
          : undefined;

        let noteText = formTitle;
        const presentedData = res.presentedForm?.[0]?.data;
        if (presentedData) {
          const decodedData = this.decodeBase64Intelligently(presentedData);
          if (decodedData) {
            noteText = formTitle === decodedData ? decodedData : `${formTitle}\n\n${decodedData}`;
          }
        }

        dtos.push({
          id: rid,
          noteText,
          noteType: NoteType.GENERAL,
          noteDate: this.parseDate(effective),
          author,
          encounterReference: res.encounter?.reference,
          encounterId: this.getEncounterId(res.encounter?.reference),
          /* contextualReasonCodes: this.getContextualReasons(
            res.encounter?.reference,
            encounterReasonMap,
          ), */
          reasonReference: res.reasonReference?.map((ref: any) => ({
            reference: ref.reference,
            display: ref.display,
          })),
          source,
          recordedAt: this.getResourceDate(res),
        });
      } catch (e) {
        this.logger.error(
          `Error parsing FHIR DiagnosticReport note ${res.id}: ${e.message}`,
        );
      }
    }
    if (skippedResultContainers) {
      this.logger.log(
        `parseNotes: skipped ${skippedResultContainers} lab-result-container ` +
          `DiagnosticReports (their values are parsed into labs)`,
      );
    }

    const docRefEntries = docRefBundle.entry || [];
    for (const entry of docRefEntries) {
      const res = entry.resource;
      if (!res || res.resourceType !== 'DocumentReference') continue;
      try {
        const rid = res.id;
        if (seenIds.has(rid)) continue;
        seenIds.add(rid);

        const docType = res.type?.text || 'Clinical Document';
        const title = res.content?.[0]?.attachment?.title || docType;
        const authorName = res.author?.[0]?.display || 'Unknown';

        let noteText = title;
        const attachmentData = res.content?.[0]?.attachment?.data;
        if (attachmentData) {
          const decodedData = this.decodeBase64Intelligently(attachmentData);
          if (decodedData) {
            noteText = title === decodedData ? decodedData : `${title}\n\n${decodedData}`;
          }
        }

        dtos.push({
          id: rid,
          noteText,
          noteType: NoteType.GENERAL,
          noteDate: this.parseDate(res.date),
          author: { name: authorName },
          encounterReference: res.context?.encounter?.[0]?.reference,
          encounterId: this.getEncounterId(res.context?.encounter?.[0]?.reference),
          /* contextualReasonCodes: this.getContextualReasons(
            res.context?.encounter?.[0]?.reference,
            encounterReasonMap,
          ), */
          reasonReference: res.reasonReference?.map((ref: any) => ({
            reference: ref.reference,
            display: ref.display,
          })),
          source,
          recordedAt: this.getResourceDate(res),
        });
      } catch (e) {
        this.logger.error(
          `Error parsing FHIR DocumentReference note ${res.id}: ${e.message}`,
        );
      }
    }
    return dtos;
  }

  private parseCoverage(bundle: any, source: DataSource): CoverageDto[] {
    const dtos: CoverageDto[] = [];
    const entries = bundle.entry || [];
    for (const entry of entries) {
      const res = entry.resource;
      if (!res || res.resourceType !== 'Coverage') continue;
      try {
        const rid = res.id;
        let planName: string | undefined;
        let groupName: string | undefined;

        for (const cls of res.class || []) {
          const cCode =
            cls.type?.coding?.[0]?.code || cls.type?.text?.toLowerCase();
          if (cCode === 'plan') planName = cls.name;
          else if (cCode === 'group') groupName = cls.name;
        }

        dtos.push({
          id: rid,
          status: res.status || 'unknown',
          type: res.type?.text,
          subscriberName: res.subscriber?.display,
          subscriberId: res.subscriberId,
          beneficiaryName: res.beneficiary?.display,
          relationship: res.relationship?.text,
          payor: res.payor?.[0]?.display,
          planName,
          groupName,
          periodStart: this.parseDate(res.period?.start),
          periodEnd: this.parseDate(res.period?.end),
          source,
          recordedAt: this.getResourceDate(res),
        });
      } catch (e) {
        this.logger.error(`Error parsing FHIR Coverage ${res.id}: ${e.message}`);
      }
    }
    return dtos;
  }

  /**
   * Parses FHIR FamilyMemberHistory into the family-history domain.
   *
   * @param bundle - bundle whose entries may hold FamilyMemberHistory resources
   * @param source - provenance stamped on every produced DTO
   * @returns one DTO per relative, each carrying their coded conditions
   */
  private parseFamilyHistory(
    bundle: any,
    source: DataSource,
  ): FamilyHistoryDto[] {
    const dtos: FamilyHistoryDto[] = [];
    for (const entry of bundle?.entry || []) {
      const res = entry?.resource;
      if (!res || res.resourceType !== 'FamilyMemberHistory') continue;
      try {
        const relCoding = res.relationship?.coding?.[0];
        const relationship =
          res.relationship?.text || relCoding?.display || 'Unknown relative';

        const conditions: FamilyHistoryConditionDto[] = [];
        for (const cond of res.condition || []) {
          const codeObj = cond?.code || {};
          const display =
            codeObj.text || codeObj.coding?.[0]?.display || 'Unknown Condition';
          conditions.push({
            display,
            code: this.extractCode(codeObj),
            codes: this.extractAllCodes(codeObj),
            onsetText:
              cond.onsetString ||
              (cond.onsetAge
                ? this.formatQuantity(cond.onsetAge)
                : cond.onsetPeriod?.start),
            contributedToDeath: cond.contributedToDeath,
          });
        }

        dtos.push({
          id: res.id,
          relationship,
          relationshipCode: relCoding?.code,
          sex: res.sex?.text || res.sex?.coding?.[0]?.code,
          deceased:
            typeof res.deceasedBoolean === 'boolean'
              ? res.deceasedBoolean
              : undefined,
          conditions,
          source,
          recordedAt: this.getResourceDate(res),
        });
      } catch (e) {
        this.logger.error(
          `Error parsing FHIR FamilyMemberHistory ${res?.id}: ${e.message}`,
        );
      }
    }
    return dtos;
  }

  /**
   * Parses social-history Observations (smoking status, alcohol use, exercise).
   *
   * These share the Observation resource with labs and vitals but carry the
   * `social-history` category, so both of those parsers reject them and the data
   * was being dropped entirely.
   *
   * @param bundle - bundle whose entries may hold Observation resources
   * @param source - provenance stamped on every produced DTO
   * @returns one DTO per social-history Observation that has a usable value
   */
  private parseSocialHistory(
    bundle: any,
    source: DataSource,
  ): SocialHistoryDto[] {
    const dtos: SocialHistoryDto[] = [];
    for (const entry of bundle?.entry || []) {
      const res = entry?.resource;
      if (!res || res.resourceType !== 'Observation') continue;

      const isSocial = (res.category || []).some(
        (cat: any) =>
          cat.text?.toLowerCase() === 'social history' ||
          (cat.coding || []).some(
            (c: any) => c.code?.toLowerCase() === 'social-history',
          ),
      );
      if (!isSocial) continue;

      try {
        const codeObj = res.code || {};
        const display =
          codeObj.text || codeObj.coding?.[0]?.display || 'Unknown Social History';

        let value: string | undefined;
        let unit: string | undefined;
        if (res.valueCodeableConcept) {
          value =
            res.valueCodeableConcept.text ||
            res.valueCodeableConcept.coding?.[0]?.display;
        } else if (res.valueString) {
          value = res.valueString;
        } else if (res.valueQuantity) {
          value = String(res.valueQuantity.value);
          unit = res.valueQuantity.unit;
        } else if (typeof res.valueBoolean === 'boolean') {
          value = String(res.valueBoolean);
        }
        if (!value) continue;

        dtos.push({
          id: res.id,
          display,
          code: this.extractCode(codeObj),
          codes: this.extractAllCodes(codeObj),
          value,
          unit,
          effectiveDate: this.parseDate(
            res.effectiveDateTime || res.effectivePeriod?.start || res.issued,
          ),
          encounterReference: res.encounter?.reference,
          encounterId: this.getEncounterId(res.encounter?.reference),
          source,
          recordedAt: this.getResourceDate(res),
        });
      } catch (e) {
        this.logger.error(
          `Error parsing FHIR social-history Observation ${res?.id}: ${e.message}`,
        );
      }
    }
    return dtos;
  }

  /**
   * Parses FHIR CarePlan into the care-plan domain.
   *
   * @param bundle - bundle whose entries may hold CarePlan resources
   * @param source - provenance stamped on every produced DTO
   * @param actorIndex - Practitioner/Organization names for activity performers
   * @returns one DTO per CarePlan, with its activities flattened
   */
  private parseCarePlans(
    bundle: any,
    source: DataSource,
    actorIndex: Map<string, string> = new Map(),
  ): CarePlanDto[] {
    const dtos: CarePlanDto[] = [];
    for (const entry of bundle?.entry || []) {
      const res = entry?.resource;
      if (!res || res.resourceType !== 'CarePlan') continue;
      try {
        const category = this.codeableConceptText(res.category);

        const activities: CarePlanActivityDto[] = [];
        for (const act of res.activity || []) {
          const detail = act?.detail;
          if (!detail) continue;
          const performerName = this.resolveActorName(
            detail.performer?.[0],
            actorIndex,
          );
          activities.push({
            display:
              detail.code?.text ||
              detail.code?.coding?.[0]?.display ||
              detail.description,
            code: detail.code ? this.extractCode(detail.code) : undefined,
            status: detail.status,
            performer: performerName ? { name: performerName } : undefined,
            scheduledStart: this.parseDate(
              detail.scheduledPeriod?.start || detail.scheduledTiming?.event?.[0],
            ),
            scheduledEnd: this.parseDate(detail.scheduledPeriod?.end),
          });
        }

        dtos.push({
          id: res.id,
          // CarePlan.title is frequently absent; fall back to the category, then
          // to a generic label, so the entry is never nameless in the UI.
          display: res.title || category || 'Care Plan',
          status: res.status,
          intent: res.intent,
          category,
          description: res.description,
          periodStart: this.parseDate(res.period?.start),
          periodEnd: this.parseDate(res.period?.end),
          activities: activities.length ? activities : undefined,
          addresses: res.addresses?.map((ref: any) => ({
            reference: ref.reference,
            display: ref.display,
          })),
          source,
          recordedAt: this.getResourceDate(res),
        });
      } catch (e) {
        this.logger.error(
          `Error parsing FHIR CarePlan ${res?.id}: ${e.message}`,
        );
      }
    }
    return dtos;
  }

  private parseProcedures(
    bundle: any,
    source: DataSource,
    encounterReasonMap: Map<string, CodeDto[]>,
    actorIndex: Map<string, string> = new Map(),
  ): ProcedureDto[] {
    const dtos: ProcedureDto[] = [];
    const entries = bundle.entry || [];
    for (const entry of entries) {
      const res = entry.resource;
      if (!res || res.resourceType !== 'Procedure') continue;
      try {
        const rid = res.id;

        // Status mapping
        let status = ProcedureStatus.UNKNOWN;
        const rawStatus = res.status;
        if (rawStatus === 'completed') status = ProcedureStatus.COMPLETED;
        else if (rawStatus === 'in-progress')
          status = ProcedureStatus.IN_PROGRESS;
        else if (rawStatus === 'not-done') status = ProcedureStatus.NOT_DONE;
        else if (rawStatus === 'on-hold') status = ProcedureStatus.ON_HOLD;
        else if (rawStatus === 'stopped') status = ProcedureStatus.STOPPED;
        else if (rawStatus === 'entered-in-error')
          status = ProcedureStatus.ENTERED_IN_ERROR;

        const codeObj = res.code || {};
        const display =
          codeObj.text || codeObj.coding?.[0]?.display || 'Unknown Procedure';
        const codeDto = this.extractCode(codeObj);

        const category = res.category?.text || res.category?.coding?.[0]?.display;

        // Date extraction
        const performedDate = this.parseDate(
          res.performedDateTime || res.performedPeriod?.start,
        );
        const performedEndDate = this.parseDate(res.performedPeriod?.end);

        // Performer extraction. Sources commonly send a bare reference with no
        // inline `display`, so fall back to the Practitioner/Organization index.
        const performerName = this.resolveActorName(
          res.performer?.[0]?.actor,
          actorIndex,
        );
        const performer = performerName ? { name: performerName } : undefined;

        // Location extraction
        const locationName = this.resolveActorName(res.location, actorIndex);
        const location = locationName ? { name: locationName } : undefined;

        // Reason references
        const reasonReference = res.reasonReference?.map((ref: any) => ({
          reference: ref.reference,
          display: ref.display,
        }));

        dtos.push({
          id: rid,
          display,
          code: codeDto,
          codes: this.extractAllCodes(codeObj),
          status,
          category,
          bodySite: this.codeableConceptText(res.bodySite),
          performedDate,
          performedEndDate,
          performer,
          location,
          reasonReference,
          encounterReference: res.encounter?.reference,
          encounterId: this.getEncounterId(res.encounter?.reference),
          source,
          recordedAt: this.getResourceDate(res),
        });
      } catch (e) {
        this.logger.error(
          `Error parsing FHIR Procedure ${res.id}: ${e.message}`,
        );
      }
    }
    return dtos;
  }

  async parsePatientData(
    patientId: string,
    baseDir: string = 'data/patients',
    source: DataSource = DataSource.EPIC,
  ): Promise<RedoxParsedData> {
    this.logger.log(`Starting ${source} FHIR Parsing for ${patientId}`);
    const patientDir = path.join(baseDir, patientId);

    // loadBundle is a utility to fetch cached FHIR resource files from disk.
    // It now supports both the standard single-object JSON Bundle format (Epic/Cerner) 
    // and the optimized NDJSON format (one resource per line) used by Fasten to save memory.
    const loadBundle = (resourceName: string) => {
      const filePath = path.join(
        patientDir,
        `${resourceName.toLowerCase()}.json`,
      );
      if (fs.existsSync(filePath)) {
        try {
          const content = fs.readFileSync(filePath, 'utf8').trim();
          if (!content) return {};

          if (content.startsWith('{')) {
            // 1. Try parsing as a single pure JSON object (Legacy Bundle or single Resource)
            try {
              const fullObj = JSON.parse(content);
              if (fullObj.resourceType === 'Bundle') return fullObj;
              if (fullObj.resourceType)
                return { entry: [{ resource: fullObj }] };
              if (fullObj.resource) return { entry: [fullObj] }; // Correctly handles already-wrapped entry
            } catch {
              /* Not a single valid JSON block — fall through to NDJSON */
            }

            // 2. Try parsing as NDJSON
            try {
              const lines = content.split('\n').filter((l) => l.trim());
              if (lines.length > 0) {
                return {
                  entry: lines.map((l) => {
                    const b = JSON.parse(l);
                    return b.resource ? b : { resource: b };
                  }),
                };
              }
            } catch {
              /* Not valid NDJSON — fall through to legacy block parsing */
            }

            // 3. Fallback for concatenated pretty-printed JSON blocks (Legacy CareEvolution raw samples)
            try {
              const blocks = content
                .split(/\n(?={)/)
                .filter((b) => b.trim())
                .map((b) => JSON.parse(b));

              return {
                entry: blocks
                  .map((b) =>
                    b.resourceType === 'Bundle'
                      ? b.entry
                      : b.resource
                        ? b
                        : { resource: b },
                  )
                  .flat(),
              };
            } catch (e) {
              this.logger.error(
                `Failed to parse FHIR ${filePath} after all attempts: ${e.message}`,
              );
            }
          }
        } catch (e) {
          this.logger.error(`Failed to read FHIR ${filePath}: ${e.message}`);
        }
      }
      return {};
    };

    const problemsBundle = loadBundle('Condition');
    const medicationReqBundle = loadBundle('MedicationRequest');
    const medicationStatementBundle = loadBundle('MedicationStatement');
    const medicationBundle = loadBundle('Medication');
    const allergiesBundle = loadBundle('AllergyIntolerance');
    const observationBundle = loadBundle('Observation');
    const vitalsBundle = loadBundle('Vitals');
    const immunizationBundle = loadBundle('Immunization');
    const encounterBundle = loadBundle('Encounter');
    const diagBundle = loadBundle('DiagnosticReport');
    const docrefBundle = loadBundle('DocumentReference');
    const coverageBundle = loadBundle('Coverage');
    const proceduresBundle = loadBundle('Procedure');
    const familyHistoryBundle = loadBundle('FamilyMemberHistory');
    const carePlanBundle = loadBundle('CarePlan');
    const practitionerBundle = loadBundle('Practitioner');
    const organizationBundle = loadBundle('Organization');

    // parseMedications consumes MedicationRequest and MedicationStatement from
    // one bundle, so combine the two sources here.
    const medicationOrderBundle = {
      entry: [
        ...(medicationReqBundle.entry || []),
        ...(medicationStatementBundle.entry || []),
      ],
    };

    const actorIndex = this.buildActorIndex(
      practitionerBundle,
      organizationBundle,
    );

    const parsedEncounters = this.parseEncounters(
      encounterBundle,
      source,
      actorIndex,
    );

    // Build encounter reason map for contextual mapping (Disabled - but kept as reference)
    const encounterReasonMap = new Map<string, CodeDto[]>();
    /* parsedEncounters.forEach((e) => {
      if (e.id && e.reasonCodes) {
        encounterReasonMap.set(e.id, e.reasonCodes);
      }
    }); */

    const parsedProblems = this.parseConditions(problemsBundle, source);
    const parsedMedications = this.parseMedications(
      medicationOrderBundle,
      medicationBundle,
      source,
      encounterReasonMap,
    );
    const parsedAllergies = this.parseAllergies(
      allergiesBundle,
      source,
      encounterReasonMap,
    );

    const parsedVitals = vitalsBundle.entry
      ? this.parseVitals(vitalsBundle, source, encounterReasonMap)
      : this.parseVitals(observationBundle, source, encounterReasonMap);

    const parsedLabs = this.parseLabs(
      observationBundle,
      source,
      encounterReasonMap,
    );
    const parsedImmunizations = this.parseImmunizations(
      immunizationBundle,
      source,
      encounterReasonMap,
    );
    const parsedImaging = this.parseImaging(
      diagBundle,
      source,
      encounterReasonMap,
      proceduresBundle,
      actorIndex,
    );
    const parsedNotes = this.parseNotes(
      diagBundle,
      docrefBundle,
      source,
      encounterReasonMap,
    );
    const parsedCoverage = this.parseCoverage(coverageBundle, source);
    const parsedProcedures = this.parseProcedures(
      proceduresBundle,
      source,
      encounterReasonMap,
      actorIndex,
    );
    const parsedFamilyHistory = this.parseFamilyHistory(
      familyHistoryBundle,
      source,
    );
    const parsedSocialHistory = this.parseSocialHistory(
      observationBundle,
      source,
    );
    const parsedCarePlans = this.parseCarePlans(
      carePlanBundle,
      source,
      actorIndex,
    );

    return {
      patientId: patientId,
      problems: parsedProblems,
      medications: parsedMedications,
      allergies: parsedAllergies,
      vitals: parsedVitals,
      labs: parsedLabs,
      immunizations: parsedImmunizations,
      encounters: parsedEncounters,
      imaging: parsedImaging,
      notes: parsedNotes,
      coverage: parsedCoverage,
      procedures: parsedProcedures,
      familyHistory: parsedFamilyHistory,
      socialHistory: parsedSocialHistory,
      carePlans: parsedCarePlans,
    };
  }

  /**
   * Parses FHIR data directly from an in-memory object (e.g., from an OCR callback).
   * Maps standard FHIR keys (conditions, observations) to their internal DTO counterparts.
   */
  async parsePatientDataFromResources(
    patientId: string,
    resources: Record<string, any[]>,
    source: DataSource = DataSource.OCR,
  ): Promise<RedoxParsedData> {
    this.logger.log(`Starting in-memory FHIR Parsing for ${patientId} (source: ${source})`);

    // On the OCR/in-memory path the array key (e.g. `observations`) is the
    // authoritative resource type, so stamp `resourceType` when the upstream
    // payload omits it. Every downstream parser hard-skips entries whose
    // `resourceType` doesn't match, so a missing value silently drops the item.
    const wrapBundle = (rawResources: any[], resourceType?: string) => ({
      entry: (rawResources || []).map((res) => ({
        resource:
          resourceType && res && !res.resourceType
            ? { ...res, resourceType }
            : res,
      })),
    });

    // Map common FHIR names to internal clinical arrays
    const encounterBundle = wrapBundle(resources.encounters || [], 'Encounter');
    const problemsBundle = wrapBundle(resources.conditions || resources.problems || [], 'Condition');
    const medicationReqBundle = wrapBundle(resources.medications || resources.medicationRequests || [], 'MedicationRequest');
    const medicationBundle = wrapBundle(resources.medicationResources || [], 'Medication'); // Extra medications if needed
    const allergiesBundle = wrapBundle(resources.allergies || resources.allergyIntolerances || [], 'AllergyIntolerance');
    const observationBundle = wrapBundle(resources.observations || [], 'Observation');
    const vitalsBundle = wrapBundle(resources.vitals || [], 'Observation');
    const immunizationBundle = wrapBundle(resources.immunizations || [], 'Immunization');
    const diagBundle = wrapBundle(resources.diagnosticReports || [], 'DiagnosticReport');
    const docrefBundle = wrapBundle(resources.documentReferences || resources.documents || [], 'DocumentReference');
    const coverageBundle = wrapBundle(resources.coverage || [], 'Coverage');
    const proceduresBundle = wrapBundle(resources.procedures || [], 'Procedure');
    const medicationStatementBundle = wrapBundle(
      resources.medicationStatements || [],
      'MedicationStatement',
    );
    const familyHistoryBundle = wrapBundle(
      resources.familyMemberHistories || [],
      'FamilyMemberHistory',
    );
    const carePlanBundle = wrapBundle(resources.carePlans || [], 'CarePlan');
    const practitionerBundle = wrapBundle(
      resources.practitioners || [],
      'Practitioner',
    );
    const organizationBundle = wrapBundle(
      resources.organizations || [],
      'Organization',
    );

    // parseMedications consumes MedicationRequest and MedicationStatement from
    // one bundle, so combine the two sources here.
    const medicationOrderBundle = {
      entry: [
        ...(medicationReqBundle.entry || []),
        ...(medicationStatementBundle.entry || []),
      ],
    };

    const actorIndex = this.buildActorIndex(
      practitionerBundle,
      organizationBundle,
    );

    const encounterReasonMap = new Map<string, CodeDto[]>();

    const parsedEncounters = this.parseEncounters(
      encounterBundle,
      source,
      actorIndex,
    );
    const parsedProblems = this.parseConditions(problemsBundle, source);
    const parsedMedications = this.parseMedications(
      medicationOrderBundle,
      medicationBundle,
      source,
      encounterReasonMap,
    );
    const parsedAllergies = this.parseAllergies(
      allergiesBundle,
      source,
      encounterReasonMap,
    );

    // If 'vitals' array is empty, attempt to extract them from 'observations'
    const parsedVitals = vitalsBundle.entry?.length
      ? this.parseVitals(vitalsBundle, source, encounterReasonMap)
      : this.parseVitals(observationBundle, source, encounterReasonMap);

    const parsedLabs = this.parseLabs(
      observationBundle,
      source,
      encounterReasonMap,
    );
    const parsedImmunizations = this.parseImmunizations(
      immunizationBundle,
      source,
      encounterReasonMap,
    );
    const parsedImaging = this.parseImaging(
      diagBundle,
      source,
      encounterReasonMap,
      proceduresBundle,
      actorIndex,
    );
    const parsedNotes = this.parseNotes(
      diagBundle,
      docrefBundle,
      source,
      encounterReasonMap,
    );
    const parsedCoverage = this.parseCoverage(coverageBundle, source);
    const parsedProcedures = this.parseProcedures(
      proceduresBundle,
      source,
      encounterReasonMap,
      actorIndex,
    );
    const parsedFamilyHistory = this.parseFamilyHistory(
      familyHistoryBundle,
      source,
    );
    // Social-history Observations arrive in the same array as labs/vitals.
    const parsedSocialHistory = this.parseSocialHistory(
      observationBundle,
      source,
    );
    const parsedCarePlans = this.parseCarePlans(
      carePlanBundle,
      source,
      actorIndex,
    );

    return {
      patientId: patientId,
      problems: parsedProblems,
      medications: parsedMedications,
      allergies: parsedAllergies,
      vitals: parsedVitals,
      labs: parsedLabs,
      immunizations: parsedImmunizations,
      encounters: parsedEncounters,
      imaging: parsedImaging,
      notes: parsedNotes,
      coverage: parsedCoverage,
      procedures: parsedProcedures,
      familyHistory: parsedFamilyHistory,
      socialHistory: parsedSocialHistory,
      carePlans: parsedCarePlans,
    };
  }
}
