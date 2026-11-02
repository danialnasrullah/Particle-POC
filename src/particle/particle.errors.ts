/**
 * Typed errors for the Particle integration.
 *
 * Mirrors redox-backend-nest `metriport/metriport.errors.ts`: every error carries
 * a stable `code` and a client-safe `detail`, so controllers can map them to the
 * VF `{ detail, code }` error body without leaking upstream responses.
 */
export abstract class ParticleError extends Error {
  abstract readonly code: string;

  constructor(
    public readonly detail: string,
    options?: { cause?: unknown },
  ) {
    super(detail, options);
    this.name = new.target.name;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** Network failure, timeout, 5xx after retries, missing config, or 429 after retries. Maps to 503. */
export class ParticleUnavailableError extends ParticleError {
  readonly code = 'PARTICLE_UNAVAILABLE';
}

/** Particle rejected the call (4xx other than 404). Maps to 400 for 4xx, 502 otherwise. */
export class ParticleApiError extends ParticleError {
  readonly code = 'PARTICLE_API_ERROR';

  constructor(
    detail: string,
    public readonly status?: number,
    options?: { cause?: unknown },
  ) {
    super(detail, options);
  }
}

/** Credentials rejected (401/403 after one token refresh). Maps to 502: our config is wrong, not the caller's input. */
export class ParticleAuthError extends ParticleError {
  readonly code = 'PARTICLE_AUTH_ERROR';
}

/** Upstream 404 (no completed query, unknown patient, nothing to fetch). */
export class ParticleNotFoundError extends ParticleError {
  readonly code = 'PARTICLE_NOT_FOUND';
}

/** Local precondition failed (unknown elevAID patient, re-query window, etc). Maps to 404/409. */
export class PatientNotRegisteredError extends ParticleError {
  readonly code = 'PATIENT_NOT_REGISTERED';
}

export class RequeryTooSoonError extends ParticleError {
  readonly code = 'REQUERY_TOO_SOON';

  constructor(
    detail: string,
    public readonly retryAfter: Date,
  ) {
    super(detail);
  }
}

/** Same external patient_id re-registered with different demographics (Particle "overlay"). */
export class DemographicsConflictError extends ParticleError {
  readonly code = 'DEMOGRAPHICS_CONFLICT';
}

export class WebhookVerificationError extends ParticleError {
  readonly code = 'WEBHOOK_SIGNATURE_INVALID';
}
