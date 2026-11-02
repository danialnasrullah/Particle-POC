import { Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { HttpService } from '@nestjs/axios';
import { isAxiosError } from 'axios';
import { lastValueFrom } from 'rxjs';
import type { ParticleConfig } from '../config/configuration';
import { ParticleAuthError, ParticleUnavailableError } from './particle.errors';
import { ParticleCallLog } from './particle-call-log';

const AUTH_TIMEOUT_MS = 15_000;
/** Refresh this long before the JWT `exp`, so in-flight calls never carry an expired token. */
const REFRESH_SKEW_MS = 10 * 60 * 1000;
/** Fallback TTL when the token has no readable `exp` (Particle documents 1 hour). */
const DEFAULT_TTL_MS = 60 * 60 * 1000;

interface CachedToken {
  value: string;
  expiresAt: number;
}

/**
 * Particle Query Flow API auth: GET /auth with credentials in custom headers,
 * plain-text JWT back (not standard OAuth2). Tokens are cached in memory only
 * and never logged.
 */
@Injectable()
export class ParticleAuthService {
  private readonly logger = new Logger(ParticleAuthService.name);
  private cached: CachedToken | null = null;
  private inFlight: Promise<string> | null = null;

  constructor(
    private readonly http: HttpService,
    private readonly config: ConfigService,
    @Optional() private readonly callLog?: ParticleCallLog,
  ) {}

  /**
   * Return a valid bearer token, fetching a new one when missing or near expiry.
   * Concurrent callers share one in-flight auth request.
   *
   * @returns JWT string.
   * @throws ParticleAuthError when Particle rejects the credentials.
   * @throws ParticleUnavailableError on missing config, network failure or 5xx.
   */
  async getToken(): Promise<string> {
    if (this.cached && Date.now() < this.cached.expiresAt - REFRESH_SKEW_MS) {
      return this.cached.value;
    }
    if (!this.inFlight) {
      this.inFlight = this.fetchToken().finally(() => {
        this.inFlight = null;
      });
    }
    return this.inFlight;
  }

  /** Drop the cached token, e.g. after a 401, so the next call re-authenticates. */
  invalidate(): void {
    this.cached = null;
  }

  private async fetchToken(): Promise<string> {
    const cfg = this.config.get<ParticleConfig>('particle');
    if (!cfg?.clientId || !cfg.clientSecret || !cfg.scope) {
      throw new ParticleUnavailableError(
        'Particle credentials are not configured (PARTICLE_CLIENT_ID / PARTICLE_CLIENT_SECRET / PARTICLE_SCOPE).',
      );
    }

    const started = Date.now();
    const record = (status: number | null, body: unknown) =>
      this.callLog?.record({
        label: 'auth',
        method: 'GET',
        path: '/auth',
        status,
        ms: Date.now() - started,
        responseBody: body,
      });
    try {
      const res = await lastValueFrom(
        this.http.get<string>(`${cfg.baseUrl}/auth`, {
          headers: {
            'client-id': cfg.clientId,
            'client-secret': cfg.clientSecret,
            scope: cfg.scope,
            accept: 'text/plain',
          },
          responseType: 'text',
          timeout: AUTH_TIMEOUT_MS,
        }),
      );
      record(res.status, res.data);
      const token = extractToken(res.data);
      if (!token) {
        throw new ParticleUnavailableError(
          'Particle /auth returned an empty token.',
        );
      }
      const exp = decodeJwtExpiry(token);
      this.cached = {
        value: token,
        expiresAt: exp ?? Date.now() + DEFAULT_TTL_MS,
      };
      this.logger.log(
        `[Particle Auth] token acquired env=${cfg.env} expiresAt=${new Date(this.cached.expiresAt).toISOString()}`,
      );
      return token;
    } catch (err) {
      if (err instanceof ParticleUnavailableError) throw err;
      if (isAxiosError(err) && err.response) {
        const status = err.response.status;
        record(status, err.response.data);
        this.logger.error(`[Particle Auth] /auth rejected status=${status}`);
        if (status === 401 || status === 403) {
          throw new ParticleAuthError(
            'Particle rejected the configured credentials.',
            { cause: err },
          );
        }
        throw new ParticleUnavailableError(
          `Particle /auth failed with status ${status}.`,
          { cause: err },
        );
      }
      record(null, 'unreachable');
      this.logger.error(
        `[Particle Auth] /auth unreachable: ${err instanceof Error ? err.message : String(err)}`,
      );
      throw new ParticleUnavailableError('Particle /auth is unreachable.', {
        cause: err,
      });
    }
  }
}

/** The endpoint documents plain text, but tolerate a JSON `{access_token}` body too. */
export function extractToken(body: unknown): string | null {
  if (typeof body !== 'string') {
    if (body && typeof body === 'object' && 'access_token' in body) {
      const t = (body as { access_token?: unknown }).access_token;
      return typeof t === 'string' && t.trim() ? t.trim() : null;
    }
    return null;
  }
  const trimmed = body.trim().replace(/^"|"$/g, '');
  if (trimmed.startsWith('{')) {
    try {
      return extractToken(JSON.parse(trimmed));
    } catch {
      return null;
    }
  }
  return trimmed || null;
}

/** Read `exp` (seconds) from a JWT without verifying it; we only need refresh timing. */
export function decodeJwtExpiry(token: string): number | null {
  const parts = token.split('.');
  if (parts.length < 2) return null;
  try {
    const payload = JSON.parse(
      Buffer.from(parts[1], 'base64url').toString('utf8'),
    ) as { exp?: unknown };
    return typeof payload.exp === 'number' ? payload.exp * 1000 : null;
  } catch {
    return null;
  }
}
