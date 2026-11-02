import {
  PatientNotRegisteredError,
  RequeryTooSoonError,
} from '../particle/particle.errors';
import type { ParticleService } from '../particle/particle.service';
import {
  ELEVAID_1,
  InMemoryParticleStore,
  PPID_1,
  PRACTICE_A,
  PRACTICE_B,
  buildConfigService,
  buildLoopRow,
  buildPatientRecord,
  buildRegisterDto,
} from '../test-utils/builders';
import { FhirParserService } from '../services/fhir-parser.service';
import { ParticleFlatParserService } from './particle-flat-parser.service';
import {
  ParticleRecordsService,
  demographicsHash,
  toParticleRegistration,
} from './particle-records.service';

const REF = { practiceId: PRACTICE_A, elevaidId: ELEVAID_1 };
const patient = { resourceType: 'Patient', id: 'p1' };
const fhirSample = {
  resourceType: 'Bundle',
  entry: [
    { resource: patient },
    {
      resource: {
        resourceType: 'Condition',
        id: 'c1',
        clinicalStatus: { coding: [{ code: 'active' }] },
        code: {
          coding: [
            {
              system: 'http://hl7.org/fhir/sid/icd-10-cm',
              code: 'I50.9',
              display: 'Heart failure, unspecified',
            },
          ],
        },
      },
    },
  ],
};

function setup() {
  const store = new InMemoryParticleStore();
  const particle = {
    registerPatient: jest
      .fn()
      .mockResolvedValue({ particle_patient_id: PPID_1 }),
    subscribeMonitoring: jest.fn().mockResolvedValue(true),
    getFhir: jest.fn(),
    unsubscribeMonitoring: jest.fn(),
  };
  const svc = new ParticleRecordsService(
    particle as unknown as ParticleService,
    new ParticleFlatParserService(),
    new FhirParserService(),
    buildConfigService(),
    store,
  );
  return { svc, store, particle };
}

describe('ParticleRecordsService', () => {
  it('maps our DTO to Particle registration fields', () => {
    expect(
      toParticleRegistration(buildRegisterDto({ phone: '(617) 555-0100' })),
    ).toEqual({
      patient_id: ELEVAID_1,
      given_name: 'Test',
      family_name: 'Patient',
      date_of_birth: '1970-12-26',
      gender: 'FEMALE',
      address_city: 'Boston',
      address_state: 'MA',
      postal_code: '02215',
      address_lines: ['1 Test St'],
      telephone: '617-555-0100',
    });
  });

  it('produces the same demographics hash regardless of key order', () => {
    const a = toParticleRegistration(buildRegisterDto());
    const b = Object.fromEntries(Object.entries(a).reverse()) as typeof a;
    expect(demographicsHash(a)).toBe(demographicsHash(b));
  });

  it('registers, subscribes when asked, stores the mapping and audits', async () => {
    const { svc, store, particle } = setup();
    const res = await svc.registerPatient(
      buildRegisterDto({ subscribeMonitoring: true }),
    );
    expect(res).toEqual({
      particlePatientId: PPID_1,
      monitoringSubscribed: true,
      demographicsChanged: false,
    });
    expect(particle.subscribeMonitoring).toHaveBeenCalledWith(PPID_1);
    expect(await store.getPatient(REF)).toMatchObject({
      particlePatientId: PPID_1,
      monitoringSubscribed: true,
    });
    expect(store.audit.map((a) => a.action)).toEqual(['SUBSCRIBE', 'REGISTER']);
  });

  it('keeps the registration when the monitoring subscription fails', async () => {
    const { svc, store, particle } = setup();
    particle.subscribeMonitoring.mockRejectedValue(new Error('boom'));
    const res = await svc.registerPatient(
      buildRegisterDto({ subscribeMonitoring: true }),
    );
    expect(res.monitoringSubscribed).toBe(false);
    expect(await store.getPatient(REF)).not.toBeNull();
  });

  it('refuses a pull for a patient not registered in this practice', async () => {
    const { svc, store } = setup();
    await store.upsertPatient(buildPatientRecord({ practiceId: PRACTICE_B }));
    await expect(svc.requestPull(REF, 'physician-1')).rejects.toBeInstanceOf(
      PatientNotRegisteredError,
    );
  });

  it('returns the in-flight query instead of starting a second one', async () => {
    const { svc, store } = setup();
    await store.upsertPatient(buildPatientRecord());
    const active = buildLoopRow({ status: 'SUBMITTED', queryId: 'q1' });
    await store.saveLoop(active);
    await expect(svc.requestPull(REF, 'physician-1')).resolves.toEqual(active);
  });

  it('enforces the 48h re-query window after a completed query', async () => {
    const { svc, store } = setup();
    await store.upsertPatient(buildPatientRecord());
    await store.saveLoop(
      buildLoopRow({
        status: 'COMPLETE',
        submittedAt: new Date(Date.now() - 3600_000).toISOString(),
      }),
    );
    await expect(svc.requestPull(REF, 'physician-1')).rejects.toBeInstanceOf(
      RequeryTooSoonError,
    );
  });

  it('allows a new pull once the window has passed', async () => {
    const { svc, store } = setup();
    await store.upsertPatient(buildPatientRecord());
    await store.saveLoop(
      buildLoopRow({
        status: 'COMPLETE',
        submittedAt: new Date(Date.now() - 49 * 3600_000).toISOString(),
      }),
    );
    await expect(svc.requestPull(REF, 'physician-1')).resolves.toMatchObject({
      status: 'QUEUED',
      requestedBy: 'physician-1',
    });
  });

  it('retrieves FHIR, keeps the raw payload and stores parsed data', async () => {
    const { svc, store, particle } = setup();
    particle.getFhir.mockResolvedValue(fhirSample);
    const outcome = await svc.retrieveAndParse(
      buildLoopRow({ status: 'RETRIEVING', queryId: 'q1' }),
    );
    expect(outcome).toBe('COMPLETE');
    expect(store.raw.map((r) => r.label)).toEqual(['fhir-q1']);
    const parsed = await store.getParsed(REF);
    expect(parsed?.resourceCounts.problems).toBe(1);
    expect(parsed?.clinicalData.problems?.[0]).toMatchObject({
      display: 'Heart failure, unspecified',
      source: 'particle',
    });
    expect(parsed?.rawResourceCount).toBe(2);
    expect(parsed?.unmappedTables).toEqual(['Patient']);
    expect(parsed?.queryId).toBe('q1');
    expect(store.audit.map((a) => a.action)).toEqual(['FHIR_RETRIEVE']);
  });

  it('reports NO_DATA when the Bundle has no clinical resources', async () => {
    const { svc, store, particle } = setup();
    particle.getFhir.mockResolvedValue({
      resourceType: 'Bundle',
      entry: [{ resource: patient }],
    });
    await expect(svc.retrieveAndParse(buildLoopRow())).resolves.toBe('NO_DATA');
    expect(await store.getParsed(REF)).toBeNull();
  });

  it('keeps Signal transitions when a later full pull is parsed', async () => {
    const { svc, store, particle } = setup();
    await svc.mergeExtras(REF, PPID_1, {
      transitions: [
        { id: 'from-signal', admittingDiagnoses: [], dischargeDiagnoses: [] },
      ],
    });
    particle.getFhir.mockResolvedValue(fhirSample);
    await svc.retrieveAndParse(buildLoopRow());
    const parsed = (await store.getParsed(REF))!;
    expect(parsed.extras.transitions.map((t) => t.id)).toEqual(['from-signal']);
    expect(parsed.resourceCounts.transitions).toBe(1);
  });
});
