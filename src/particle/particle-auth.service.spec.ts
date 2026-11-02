import type { HttpService } from '@nestjs/axios';
import { AxiosError, type AxiosResponse } from 'axios';
import { of, throwError } from 'rxjs';
import { buildConfigService, fakeJwt } from '../test-utils/builders';
import {
  ParticleAuthService,
  decodeJwtExpiry,
  extractToken,
} from './particle-auth.service';
import { ParticleAuthError, ParticleUnavailableError } from './particle.errors';

function httpReturning(...tokens: string[]) {
  const get = jest.fn();
  for (const t of tokens)
    get.mockReturnValueOnce(
      of({ data: t, status: 200 } as AxiosResponse<string>),
    );
  return { http: { get } as unknown as HttpService, get };
}

describe('ParticleAuthService', () => {
  it('sends credentials as custom headers and caches the token', async () => {
    const token = fakeJwt(Math.floor(Date.now() / 1000) + 3600);
    const { http, get } = httpReturning(token);
    const svc = new ParticleAuthService(http, buildConfigService());

    await expect(svc.getToken()).resolves.toBe(token);
    await expect(svc.getToken()).resolves.toBe(token);

    expect(get).toHaveBeenCalledTimes(1);
    const [url, opts] = get.mock.calls[0];
    expect(url).toBe('https://sandbox.particlehealth.test/auth');
    expect(opts.headers).toMatchObject({
      'client-id': 'test-client',
      scope: 'projects/test',
    });
  });

  it('refreshes a token that is within 10 minutes of expiry', async () => {
    const soon = fakeJwt(Math.floor(Date.now() / 1000) + 5 * 60);
    const later = fakeJwt(Math.floor(Date.now() / 1000) + 3600);
    const { http, get } = httpReturning(soon, later);
    const svc = new ParticleAuthService(http, buildConfigService());

    await svc.getToken();
    await expect(svc.getToken()).resolves.toBe(later);
    expect(get).toHaveBeenCalledTimes(2);
  });

  it('shares one in-flight auth request between concurrent callers', async () => {
    const token = fakeJwt(Math.floor(Date.now() / 1000) + 3600);
    const { http, get } = httpReturning(token);
    const svc = new ParticleAuthService(http, buildConfigService());
    await Promise.all([svc.getToken(), svc.getToken(), svc.getToken()]);
    expect(get).toHaveBeenCalledTimes(1);
  });

  it('raises ParticleAuthError when Particle rejects the credentials', async () => {
    const err = new AxiosError('unauthorized', '401', undefined, undefined, {
      status: 401,
    } as AxiosResponse);
    const http = {
      get: jest.fn(() => throwError(() => err)),
    } as unknown as HttpService;
    await expect(
      new ParticleAuthService(http, buildConfigService()).getToken(),
    ).rejects.toBeInstanceOf(ParticleAuthError);
  });

  it('refuses to call Particle when credentials are not configured', async () => {
    const { http, get } = httpReturning('x');
    const svc = new ParticleAuthService(
      http,
      buildConfigService({ clientSecret: '' }),
    );
    await expect(svc.getToken()).rejects.toBeInstanceOf(
      ParticleUnavailableError,
    );
    expect(get).not.toHaveBeenCalled();
  });

  it('extracts tokens from plain text, quoted text or JSON bodies', () => {
    expect(extractToken('abc\n')).toBe('abc');
    expect(extractToken('"abc"')).toBe('abc');
    expect(extractToken('{"access_token":"abc"}')).toBe('abc');
    expect(extractToken('')).toBeNull();
  });

  it('reads exp from a JWT and tolerates malformed tokens', () => {
    expect(decodeJwtExpiry(fakeJwt(100))).toBe(100_000);
    expect(decodeJwtExpiry('not-a-jwt')).toBeNull();
  });
});
