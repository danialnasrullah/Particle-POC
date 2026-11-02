import { buildConfigService, PPID_1 } from '../test-utils/builders';
import type { ParticleHttpService } from './particle-http.service';
import { ParticleService, normaliseQueryStatus } from './particle.service';
import { ParticleApiError, ParticleNotFoundError } from './particle.errors';

function setup(impl: jest.Mock) {
  return new ParticleService(
    { request: impl } as unknown as ParticleHttpService,
    buildConfigService(),
  );
}

describe('ParticleService', () => {
  describe('normaliseQueryStatus', () => {
    it.each([
      [{ state: 'PROCESSING' }, 'RUNNING'],
      [{ status: 'SCHEDULED' }, 'PENDING'],
      [{ state: 'COMPLETE', files_available: 4 }, 'COMPLETE'],
      [{ status: 'TIMEOUT' }, 'PARTIAL'],
      [{ state: 'FAILED', error_message: 'x' }, 'FAILED'],
      [{ state: 'SOMETHING_NEW' }, 'UNKNOWN'],
      [[{ state: 'PENDING' }, { state: 'COMPLETE' }], 'COMPLETE'],
    ])('normalises %j to %s', (body, expected) => {
      expect(normaliseQueryStatus(body).state).toBe(expected);
    });

    it('reads file counts that arrive as strings', () => {
      expect(
        normaliseQueryStatus({ state: 'COMPLETE', file_count: '12' })
          .filesAvailable,
      ).toBe(12);
    });
  });

  it('sends the configured purpose of use when submitting a query', async () => {
    const request = jest
      .fn()
      .mockResolvedValue({ status: 200, data: { query_id: 'q1' } });
    await expect(setup(request).submitQuery(PPID_1)).resolves.toEqual({
      query_id: 'q1',
    });
    expect(request.mock.calls[0][0]).toMatchObject({
      method: 'POST',
      body: { purpose_of_use: 'TREATMENT' },
    });
  });

  it('treats a status 404 right after submit as PENDING', async () => {
    const request = jest
      .fn()
      .mockRejectedValue(new ParticleNotFoundError('404'));
    await expect(
      setup(request).getQueryStatus(PPID_1, 'q1'),
    ).resolves.toMatchObject({ state: 'PENDING', queryId: 'q1' });
  });

  it('returns {} for Flat when Particle has nothing', async () => {
    const request = jest
      .fn()
      .mockRejectedValue(new ParticleNotFoundError('404'));
    await expect(setup(request).getFlat(PPID_1)).resolves.toEqual({});
  });

  it('fetches the FHIR Bundle, and returns {} when Particle has nothing', async () => {
    const bundle = { resourceType: 'Bundle', entry: [] };
    const ok = jest.fn().mockResolvedValue({ status: 200, data: bundle });
    await expect(setup(ok).getFhir(PPID_1)).resolves.toEqual(bundle);
    expect(ok.mock.calls[0][0]).toMatchObject({
      method: 'GET',
      path: `/api/v2/patients/${PPID_1}/fhir`,
    });
    const missing = jest
      .fn()
      .mockRejectedValue(new ParticleNotFoundError('404'));
    await expect(setup(missing).getFhir(PPID_1)).resolves.toEqual({});
  });

  it('treats 400 on subscribe as already subscribed', async () => {
    const request = jest
      .fn()
      .mockRejectedValue(new ParticleApiError('dup', 400));
    await expect(setup(request).subscribeMonitoring(PPID_1)).resolves.toBe(
      false,
    );
  });

  it('raises a demographics conflict when Particle reports an overlay', async () => {
    const cause = {
      isAxiosError: true,
      response: { data: { message: 'Overlay detected for patient_id' } },
    };
    const request = jest
      .fn()
      .mockRejectedValue(new ParticleApiError('bad', 400, { cause }));
    await expect(
      setup(request).registerPatient({
        patient_id: 'p',
        given_name: 'a',
        family_name: 'b',
        date_of_birth: '1970-01-01',
        gender: 'MALE',
        postal_code: '02215',
        address_city: 'Boston',
        address_state: 'MA',
      }),
    ).rejects.toMatchObject({ code: 'DEMOGRAPHICS_CONFLICT' });
  });
});
