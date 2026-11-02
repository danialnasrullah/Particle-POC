import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  AllergyStatus,
  ClinicalStatus,
  DataSource,
  ImmunizationStatus,
  LabResultStatus,
  MedicationStatus,
} from '../types/clinical.types';
import type { ParticleFlatResponse } from '../particle/particle.types';
import { ELEVAID_1 } from '../test-utils/builders';
import {
  ParticleFlatParserService,
  mapLabStatus,
} from './particle-flat-parser.service';

const sample = JSON.parse(
  fs.readFileSync(
    path.join(__dirname, '__fixtures__', 'flat-sample.json'),
    'utf8',
  ),
) as ParticleFlatResponse;

describe('ParticleFlatParserService', () => {
  const parser = new ParticleFlatParserService();

  it('maps the Particle sandbox sample into RedoxParsedData keyed by the elevAID id', () => {
    const { clinicalData, resourceCounts, rawResourceCount } = parser.parse(
      ELEVAID_1,
      sample,
    );

    expect(clinicalData.patientId).toBe(ELEVAID_1);
    expect(resourceCounts).toMatchObject({
      problems: 3,
      medications: 3,
      labs: 3,
      vitals: 3,
      procedures: 3,
      encounters: 3,
    });
    expect(rawResourceCount).toBeGreaterThan(0);
    const all = [
      ...clinicalData.problems!,
      ...clinicalData.medications!,
      ...clinicalData.labs!,
    ];
    expect(all.every((x) => x.source === DataSource.PARTICLE)).toBe(true);
  });

  it('maps a problem with codes, status and dates', () => {
    const problem = parser.parse(ELEVAID_1, sample).clinicalData.problems![0];
    expect(problem.display).toBe('Diabetic renal disease (disorder)');
    expect(problem.clinicalStatus).toBe(ClinicalStatus.ACTIVE);
    expect(problem.code).toEqual({
      system: 'http://snomed.info/sct',
      value: '127013003',
    });
    expect(problem.onsetDate?.toISOString()).toBe('2011-05-28T15:19:11.000Z');
    expect(problem.encounterId).toBeUndefined();
  });

  it('collapses duplicated medication names and builds dosage text', () => {
    const med = parser.parse(ELEVAID_1, sample).clinicalData.medications![0];
    expect(med.display).toBe('Epinephrine 0.3 MG Auto-Injector');
    expect(med.dosage).toBe('0.3 mg');
    expect(med.route).toBe('Intramuscular');
    expect(med.status).toBe(MedicationStatus.COMPLETED);
    expect(med.code?.system).toBe(
      'http://www.nlm.nih.gov/research/umls/rxnorm',
    );
  });

  it('keeps transitions but drops the demographic columns Particle includes on them', () => {
    const { transitions } = parser.parse(ELEVAID_1, sample).extras;
    expect(transitions.length).toBeGreaterThan(0);
    const t = transitions[0] as unknown as Record<string, unknown>;
    expect(t.status).toBe('admission');
    for (const field of [
      'first_name',
      'last_name',
      'dob',
      'address',
      'phone_number',
      'firstName',
      'dob',
    ]) {
      expect(t[field]).toBeUndefined();
    }
  });

  it('flags AI outputs as AI-generated and attaches their citations', () => {
    const { aiOutputs } = parser.parse(ELEVAID_1, sample).extras;
    expect(aiOutputs.length).toBe(2);
    expect(aiOutputs.every((o) => o.isAiGenerated)).toBe(true);
    expect(aiOutputs.some((o) => o.citations.length > 0)).toBe(true);
  });

  it('maps allergies, immunizations, coverage, family and social history from hand-built rows', () => {
    const flat: ParticleFlatResponse = {
      allergies: [
        {
          allergy_id: 'a1',
          allergy_name: 'Penicillin',
          allergy_code: '7980',
          allergy_code_system: 'urn:oid:2.16.840.1.113883.6.88',
          reaction_manifestation: 'Hives|Rash',
        },
      ],
      immunizations: [
        {
          immunization_id: 'i1',
          immunization_name: 'Influenza',
          immunization_status: 'not done',
          immunization_dosage_value: '0.5',
          immunization_dosage_unit: 'mL',
        },
      ],
      coverages: [
        {
          coverage_id: 'c1',
          status: 'ACTIVE',
          type_display: 'Medicare',
          payor_reference: 'o1',
        },
      ],
      organizations: [{ organization_id: 'o1', organization_name: 'CMS' }],
      familyMemberHistories: [
        {
          family_member_history_id: 'f1',
          family_member_history_condition_display: 'Stroke',
          family_member_history_relationship_display: 'Mother',
        },
      ],
      socialHistories: [
        {
          social_history_observation_id: 's1',
          social_history_observation_name: 'Tobacco use',
          social_history_observation_value: 'Never smoker',
        },
      ],
    };
    const d = parser.parse(ELEVAID_1, flat).clinicalData;
    expect(d.allergies![0]).toMatchObject({
      id: 'a1',
      status: AllergyStatus.ACTIVE,
      reactions: [{ manifestations: ['Hives', 'Rash'] }],
    });
    expect(d.immunizations![0]).toMatchObject({
      status: ImmunizationStatus.NOT_DONE,
      doseQuantity: '0.5 mL',
    });
    expect(d.coverage![0]).toMatchObject({
      status: 'active',
      type: 'Medicare',
      payor: 'CMS',
    });
    expect(d.familyHistory![0]).toMatchObject({
      relationship: 'Mother',
      conditions: [{ display: 'Stroke' }],
    });
    expect(d.socialHistory![0]).toMatchObject({
      display: 'Tobacco use',
      value: 'Never smoker',
    });
  });

  it('skips rows with no display name instead of emitting empty records', () => {
    const d = parser.parse(ELEVAID_1, {
      problems: [{ condition_id: 'x', condition_name: '' }],
    }).clinicalData;
    expect(d.problems).toEqual([]);
  });

  it('reports Flat tables it does not map yet', () => {
    const r = parser.parse(ELEVAID_1, {
      medicationFills: [{ record_id: '1' }],
      brandNewTable: [{ a: 1 }],
    });
    expect(r.unmappedTables).toEqual(['medicationFills', 'brandNewTable']);
  });

  it('returns empty collections for an empty payload', () => {
    const r = parser.parse(ELEVAID_1, {});
    expect(r.rawResourceCount).toBe(0);
    expect(r.clinicalData.problems).toEqual([]);
  });

  it.each([
    ['H', LabResultStatus.ELEVATED],
    ['Low', LabResultStatus.LOW],
    ['HH', LabResultStatus.CRITICAL],
    ['Abnormal', LabResultStatus.ABNORMAL],
    ['', LabResultStatus.NORMAL],
  ])('maps lab interpretation %s to %s', (input, expected) => {
    expect(mapLabStatus(input)).toBe(expected);
  });
});
