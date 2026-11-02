import { Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { HttpService } from '@nestjs/axios';
import { isAxiosError, type AxiosRequestConfig, type Method } from 'axios';
import { lastValueFrom } from 'rxjs';
import type { ParticleConfig } from '../config/configuration';
import { ParticleAuthService } from './particle-auth.service';
import { ParticleCallLog } from './particle-call-log';
import {
  ParticleApiError,
  ParticleAuthError,
  ParticleNotFoundError,
  ParticleUnavailableError,
} from './particle.errors';

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_RETRIES = 3;
const BASE_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 60_000;

export interface ParticleRequest {
  method: Method;
  path: string;
  body?: unknown;
  params?: Record<string, string>;
  /** Raw query string appended as-is, for Particle's bare dataset flags (e.g. `?TRANSITIONS`). */
  rawQuery?: string;
  responseType?: AxiosRequestConfig['responseType'];
  timeoutMs?: number;
  /** Short label for logs, e.g. `query.submit`. Never include PHI. */
  label: string;
}

export interface ParticleResponse<T> {
  status: number;
  data: T;
}

/**
 * Thin authenticated HTTP wrapper over the Particle Query Flow API.
 *
 * Retries network errors, 429 (honouring Retry-After) and 5xx with exponential
 * backoff + jitter; refreshes the token once on 401. Maps the final failure to a
 * typed `ParticleError`. Bodies are never logged (they carry PHI).
 */
@Injectable()
export class ParticleHttpService {
  private readonly logger = new Logger(ParticleHttpService.name);
  /** Overridable in tests to avoid real waits. */
  sleep: (ms: number) => Promise<void> = (ms) =>
    new Promise((resolve) => setTimeout(resolve, ms));

  constructor(
    private readonly http: HttpService,
    private readonly config: ConfigService,
    private readonly auth: ParticleAuthService,
    @Optional() private readonly callLog?: ParticleCallLog,
  ) {}

  private recordCall(
    req: ParticleRequest,
    status: number | null,
    started: number,
    responseBody: unknown,
  ): void {
    const query =
      req.rawQuery ??
      (req.params ? new URLSearchParams(req.params).toString() : '');
    this.callLog?.record({
      label: req.label,
      method: req.method,
      path: query ? `${req.path}?${query}` : req.path,
      status,
      ms: Date.now() - started,
      requestBody: req.body,
      responseBody,
    });
  }

  /**
   * Execute an authenticated request against the configured Particle base URL.
   *
   * @param req Request description.
   * @returns Status and parsed body.
   * @throws ParticleNotFoundError on 404.
   * @throws ParticleAuthError when credentials are rejected after one refresh.
   * @throws ParticleApiError on other 4xx.
   * @throws ParticleUnavailableError on network failure / 429 / 5xx after retries.
   */
  async request<T>(req: ParticleRequest): Promise<ParticleResponse<T>> {
    const cfg = this.requireConfig();
    let refreshedAfter401 = false;

    for (let attempt = 0; ; attempt++) {
      const token = await this.auth.getToken();
      const url = `${cfg.baseUrl}${req.path}${req.rawQuery ? `?${req.rawQuery}` : ''}`;
      const started = Date.now();
      try {
        const res = await lastValueFrom(
          this.http.request<T>({
            method: req.method,
            url,
            data: req.body,
            params: req.params,
            responseType: req.responseType ?? 'json',
            timeout: req.timeoutMs ?? DEFAULT_TIMEOUT_MS,
            headers: {
              Authorization: `Bearer ${token}`,
              ...(req.body !== undefined
                ? { 'Content-Type': 'application/json' }
                : {}),
            },
          }),
        );
        this.logger.debug(
          `[Particle HTTP] ${req.label} status=${res.status} ms=${Date.now() - started}`,
        );
        this.recordCall(req, res.status, started, res.data);
        return { status: res.status, data: res.data };
      } catch (err) {
        const status = isAxiosError(err) ? err.response?.status : undefined;
        this.recordCall(
          req,
          status ?? null,
          started,
          isAxiosError(err)
            ? (err.response?.data ?? err.message)
            : String(err),
        );

        if (status === 401 && !refreshedAfter401) {
          refreshedAfter401 = true;
          this.auth.invalidate();
          this.logger.warn(
            `[Particle HTTP] ${req.label} 401, refreshing token and retrying once`,
          );
          continue;
        }

        const retryable =
          status === undefined || status === 429 || status >= 500;
        if (retryable && attempt < MAX_RETRIES) {
          const delay = this.backoffMs(attempt, err);
          this.logger.warn(
            `[Particle HTTP] ${req.label} ${status ?? 'network-error'} attempt=${attempt + 1}/${MAX_RETRIES + 1} retryInMs=${delay}`,
          );
          await this.sleep(delay);
          continue;
        }

        throw this.toParticleError(req.label, err, status);
      }
    }
  }

  private requireConfig(): ParticleConfig {
    const cfg = this.config.get<ParticleConfig>('particle');
    if (!cfg) {
      throw new ParticleUnavailableError('Particle config block is missing.');
    }
    if (cfg.env === 'production' && !cfg.allowProduction) {
      throw new ParticleUnavailableError(
        'Production Particle access is disabled in this POC (set PARTICLE_ALLOW_PRODUCTION=true deliberately).',
      );
    }
    return cfg;
  }

  private backoffMs(attempt: number, err: unknown): number {
    const exp = Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * 2 ** attempt);
    const jitter = Math.floor(Math.random() * 250);
    let delay = exp + jitter;
    if (isAxiosError(err)) {
      const retryAfter = Number(err.response?.headers?.['retry-after']);
      if (Number.isFinite(retryAfter) && retryAfter > 0) {
        delay = Math.max(delay, Math.min(MAX_BACKOFF_MS, retryAfter * 1000));
      }
    }
    return delay;
  }

  private toParticleError(label: string, err: unknown, status?: number) {
    if (status === undefined) {
      this.logger.error(
        `[Particle HTTP] ${label} unreachable: ${err instanceof Error ? err.message : String(err)}`,
      );
      return new ParticleUnavailableError(
        `Particle is unreachable (${label}).`,
        {
          cause: err,
        },
      );
    }
    this.logger.error(`[Particle HTTP] ${label} failed status=${status}`);
    if (status === 404) {
      return new ParticleNotFoundError(`Particle returned 404 (${label}).`, {
        cause: err,
      });
    }
    if (status === 401 || status === 403) {
      return new ParticleAuthError(
        `Particle denied access (${label}, status ${status}). Check credentials and which data formats are provisioned.`,
        { cause: err },
      );
    }
    if (status === 429 || status >= 500) {
      return new ParticleUnavailableError(
        `Particle unavailable (${label}, status ${status}).`,
        { cause: err },
      );
    }
    return new ParticleApiError(
      `Particle rejected the request (${label}, status ${status}).`,
      status,
      { cause: err },
    );
  }
}

/** Pull Particle's own error message out of a failed response, for local logs only. Never returned to clients. */
export function upstreamMessage(err: unknown): string | undefined {
  if (!isAxiosError(err)) return undefined;
  const data: unknown = err.response?.data;
  if (typeof data === 'string') return data.slice(0, 300);
  if (data && typeof data === 'object') {
    const d = data as Record<string, unknown>;
    const msg = d.message ?? d.error ?? d.detail;
    return typeof msg === 'string' ? msg.slice(0, 300) : undefined;
  }
  return undefined;
}
