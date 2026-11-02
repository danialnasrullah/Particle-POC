import { buildConfigService, PPID_1 } from '../test-utils/builders';
import { ParticleCallLog, summarizeBody } from './particle-call-log';

const call = (path: string, responseBody: unknown, label = 'x') => ({
  label,
  method: 'get',
  path,
  status: 200,
  ms: 5,
  responseBody,
});

describe('ParticleCallLog', () => {
  it('never shows the auth token', () => {
    expect(summarizeBody('eyJhbGciOi.secret.sig', 'auth')).not.toContain(
      'eyJ',
    );
  });

  it('summarises a FHIR Bundle by resource type', () => {
    const bundle = {
      resourceType: 'Bundle',
      type: 'searchset',
      entry: [
        { resource: { resourceType: 'Condition' } },
        { resource: { resourceType: 'Observation' } },
        { resource: { resourceType: 'Observation' } },
      ],
    };
    expect(summarizeBody(bundle, 'fhir.all')).toBe(
      'FHIR Bundle (searchset), 3 entries: Observation 2, Condition 1',
    );
  });

  it('shows small bodies in full and large objects as row counts', () => {
    expect(summarizeBody({ state: 'COMPLETE' }, 'q')).toBe(
      '{"state":"COMPLETE"}',
    );
    const big = { labs: Array.from({ length: 200 }, () => ({ v: 'x' })) };
    expect(summarizeBody(big, 'flat')).toMatch(/labs: 200 rows$/);
  });

  it('lists only this patient’s calls (plus auth), tagged by path or registration response', () => {
    const log = new ParticleCallLog(buildConfigService());
    log.record(call('/auth', 'token', 'auth'));
    log.record(call('/api/v2/patients', { particle_patient_id: PPID_1 }));
    log.record(call(`/api/v2/patients/${PPID_1}/fhir`, {}));
    log.record(
      call('/api/v2/patients/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb/fhir', {}),
    );
    expect(log.list(PPID_1).map((e) => e.path)).toEqual([
      '/auth',
      '/api/v2/patients',
      `/api/v2/patients/${PPID_1}/fhir`,
    ]);
  });

  it('keeps nothing outside the sandbox', () => {
    const log = new ParticleCallLog(buildConfigService({ env: 'production' }));
    log.record(call(`/api/v2/patients/${PPID_1}/fhir`, {}));
    expect(log.list(PPID_1)).toEqual([]);
  });
});
