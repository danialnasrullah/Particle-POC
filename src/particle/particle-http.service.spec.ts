import type { HttpService } from '@nestjs/axios';
import { AxiosError, type AxiosResponse } from 'axios';
import { of, throwError } from 'rxjs';
import { buildConfigService } from '../test-utils/builders';
import type { ParticleAuthService } from './particle-auth.service';
import { ParticleHttpService } from './particle-http.service';
import {
  ParticleApiError,
  ParticleNotFoundError,
  ParticleUnavailableError,
} from './particle.errors';

const httpError = (status: number, headers: Record<string, string> = {}) =>
  new AxiosError(`status ${status}`, String(status), undefined, undefined, {
    status,
    headers,
    data: {},
  } as AxiosResponse);

function setup(responses: Array<AxiosResponse | AxiosError>, particle = {}) {
  const request = jest.fn();
  for (const r of responses) {
    request.mockReturnValueOnce(
      r instanceof AxiosError ? throwError(() => r) : of(r),
    );
  }
  const auth = {
    getToken: jest.fn().mockResolvedValue('tok'),
    invalidate: jest.fn(),
  };
  const svc = new ParticleHttpService(
    { request } as unknown as HttpService,
    buildConfigService(particle),
    auth as unknown as ParticleAuthService,
  );
  svc.sleep = jest.fn().mockResolvedValue(undefined);
  return { svc, request, auth };
}

const ok = (data: unknown) => ({ status: 200, data }) as AxiosResponse;

describe('ParticleHttpService', () => {
  it('adds the bearer token and returns the body', async () => {
    const { svc, request } = setup([ok({ a: 1 })]);
    const res = await svc.request({ method: 'GET', path: '/x', label: 't' });
    expect(res.data).toEqual({ a: 1 });
    expect(request.mock.calls[0][0].headers.Authorization).toBe('Bearer tok');
  });

  it('retries 5xx and network errors, then succeeds', async () => {
    const { svc, request } = setup([
      httpError(503),
      new AxiosError('ECONNRESET'),
      ok('done'),
    ]);
    await expect(
      svc.request({ method: 'GET', path: '/x', label: 't' }),
    ).resolves.toMatchObject({ data: 'done' });
    expect(request).toHaveBeenCalledTimes(3);
  });

  it('honours Retry-After on 429', async () => {
    const { svc } = setup([httpError(429, { 'retry-after': '7' }), ok('ok')]);
    await svc.request({ method: 'GET', path: '/x', label: 't' });
    expect((svc.sleep as jest.Mock).mock.calls[0][0]).toBeGreaterThanOrEqual(
      7000,
    );
  });

  it('gives up after the retry budget with ParticleUnavailableError', async () => {
    const { svc, request } = setup([
      httpError(500),
      httpError(500),
      httpError(500),
      httpError(500),
    ]);
    await expect(
      svc.request({ method: 'GET', path: '/x', label: 't' }),
    ).rejects.toBeInstanceOf(ParticleUnavailableError);
    expect(request).toHaveBeenCalledTimes(4);
  });

  it('refreshes the token once on 401', async () => {
    const { svc, auth } = setup([httpError(401), ok('ok')]);
    await svc.request({ method: 'GET', path: '/x', label: 't' });
    expect(auth.invalidate).toHaveBeenCalledTimes(1);
  });

  it('maps 404 to ParticleNotFoundError and other 4xx to ParticleApiError without retrying', async () => {
    const a = setup([httpError(404)]);
    await expect(
      a.svc.request({ method: 'GET', path: '/x', label: 't' }),
    ).rejects.toBeInstanceOf(ParticleNotFoundError);
    const b = setup([httpError(422)]);
    await expect(
      b.svc.request({ method: 'GET', path: '/x', label: 't' }),
    ).rejects.toBeInstanceOf(ParticleApiError);
    expect(b.request).toHaveBeenCalledTimes(1);
  });

  it('refuses production unless explicitly allowed', async () => {
    const { svc, request } = setup([ok('x')], {
      env: 'production',
      allowProduction: false,
    });
    await expect(
      svc.request({ method: 'GET', path: '/x', label: 't' }),
    ).rejects.toBeInstanceOf(ParticleUnavailableError);
    expect(request).not.toHaveBeenCalled();
  });

  it('appends bare dataset flags as a raw query string', async () => {
    const { svc, request } = setup([ok({})]);
    await svc.request({
      method: 'GET',
      path: '/flat',
      rawQuery: 'AI_OUTPUTS&AI_CITATIONS',
      label: 't',
    });
    expect(request.mock.calls[0][0].url).toBe(
      'https://sandbox.particlehealth.test/flat?AI_OUTPUTS&AI_CITATIONS',
    );
  });
});
