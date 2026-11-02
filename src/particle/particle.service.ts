import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { ParticleConfig } from '../config/configuration';
import { ParticleHttpService, upstreamMessage } from './particle-http.service';
import {
  DemographicsConflictError,
  ParticleApiError,
  ParticleError,
  ParticleNotFoundError,
} from './particle.errors';
import type {
  NormalisedQueryState,
  ParticleFhirBundle,
  ParticleFlatResponse,
  ParticlePatientRegistration,
  ParticlePatientResponse,
  ParticleQueryStatus,
  ParticleQuerySubmitResponse,
} from './particle.types';

/** Flat/FHIR payloads for long histories can be large; give retrieval more time than control calls. */
const FLAT_TIMEOUT_MS = 120_000;
const CCDA_TIMEOUT_MS = 180_000;

/**
 * Typed wrapper over the Particle Query Flow + Signal endpoints used by elevAID.
 * Stateless: persistence and orchestration live in particle-records.
 */
@Injectable()
export class ParticleService {
  private readonly logger = new Logger(ParticleService.name);

  constructor(
    private readonly http: ParticleHttpService,
    private readonly config: ConfigService,
  ) {}

  /**
   * Register or update a patient (POST /api/v2/patients).
   *
   * @param input Demographics; `patient_id` is our elevAID patient UUID.
   * @returns Particle's response including `particle_patient_id`.
   * @throws DemographicsConflictError when Particle reports an overlay (same id, different person).
   */
  async registerPatient(
    input: ParticlePatientRegistration,
  ): Promise<ParticlePatientResponse> {
    try {
      const res = await this.http.request<ParticlePatientResponse>({
        method: 'POST',
        path: '/api/v2/patients',
        body: input,
        label: 'patients.register',
      });
      if (!res.data?.particle_patient_id) {
        throw new ParticleApiError(
          'Particle registration response had no particle_patient_id.',
          res.status,
        );
      }
      return res.data;
    } catch (err) {
      if (
        err instanceof ParticleApiError &&
        /overlay/i.test(upstreamMessage(err.cause) ?? '')
      ) {
        throw new DemographicsConflictError(
          'Particle already holds different demographics for this patient_id (overlay). Resolve the identity before re-registering.',
          { cause: err },
        );
      }
      throw err;
    }
  }

  /**
   * Start a network query (POST /api/v2/patients/{ppid}/query).
   *
   * @returns The submit response; `query_id` may be absent on older API versions.
   */
  async submitQuery(
    particlePatientId: string,
  ): Promise<ParticleQuerySubmitResponse> {
    const cfg = this.config.get<ParticleConfig>('particle');
    const res = await this.http.request<ParticleQuerySubmitResponse>({
      method: 'POST',
      path: `/api/v2/patients/${encodeURIComponent(particlePatientId)}/query`,
      body: { purpose_of_use: cfg?.purposeOfUse ?? 'TREATMENT' },
      label: 'query.submit',
    });
    return res.data ?? {};
  }

  /**
   * Read query status (GET /api/v2/patients/{ppid}/query).
   * A 404 shortly after submit is a known propagation delay and is reported as PENDING.
   */
  async getQueryStatus(
    particlePatientId: string,
    queryId?: string | null,
  ): Promise<ParticleQueryStatus> {
    try {
      const res = await this.http.request<Record<string, unknown>>({
        method: 'GET',
        path: `/api/v2/patients/${encodeURIComponent(particlePatientId)}/query`,
        params: queryId ? { query_id: queryId } : undefined,
        label: 'query.status',
      });
      return normaliseQueryStatus(res.data);
    } catch (err) {
      if (err instanceof ParticleNotFoundError) {
        return {
          state: 'PENDING',
          rawState: '404',
          queryId: queryId ?? null,
          filesAvailable: null,
          errorMessage: null,
        };
      }
      throw err;
    }
  }

  /**
   * Fetch Flat data (GET /api/v2/patients/{ppid}/flat), optionally limited to datasets.
   * Particle takes datasets as bare query flags (`?MEDICATIONS&LABS`).
   *
   * @returns Flat payload; `{}` when Particle has nothing (404 or empty).
   */
  async getFlat(
    particlePatientId: string,
    datasets?: string[],
  ): Promise<ParticleFlatResponse> {
    try {
      const res = await this.http.request<ParticleFlatResponse>({
        method: 'GET',
        path: `/api/v2/patients/${encodeURIComponent(particlePatientId)}/flat`,
        rawQuery: datasets?.length
          ? datasets.map((d) => encodeURIComponent(d)).join('&')
          : undefined,
        timeoutMs: FLAT_TIMEOUT_MS,
        label: datasets?.length ? `flat.${datasets.join('+')}` : 'flat.all',
      });
      return res.data && typeof res.data === 'object' ? res.data : {};
    } catch (err) {
      if (err instanceof ParticleNotFoundError) return {};
      throw err;
    }
  }

  /**
   * Fetch the patient's records as a FHIR R4 Bundle (GET /api/v2/patients/{ppid}/fhir).
   *
   * @returns The Bundle; `{}` when Particle has nothing (404 or empty).
   */
  async getFhir(particlePatientId: string): Promise<ParticleFhirBundle> {
    try {
      const res = await this.http.request<ParticleFhirBundle>({
        method: 'GET',
        path: `/api/v2/patients/${encodeURIComponent(particlePatientId)}/fhir`,
        timeoutMs: FLAT_TIMEOUT_MS,
        label: 'fhir.all',
      });
      return res.data && typeof res.data === 'object' ? res.data : {};
    } catch (err) {
      if (err instanceof ParticleNotFoundError) return {};
      throw err;
    }
  }

  /**
   * Fetch one Flat resource by id, e.g. a transition referenced by a Signal alert
   * (`flat?resource_type=TRANSITIONS&resource_id=...`).
   */
  async getFlatResource(
    particlePatientId: string,
    resourceType: 'TRANSITIONS' | 'AI_OUTPUTS',
    resourceId: string,
  ): Promise<ParticleFlatResponse> {
    try {
      const res = await this.http.request<ParticleFlatResponse>({
        method: 'GET',
        path: `/api/v2/patients/${encodeURIComponent(particlePatientId)}/flat`,
        params: { resource_type: resourceType, resource_id: resourceId },
        label: `flat.${resourceType.toLowerCase()}.one`,
      });
      return res.data && typeof res.data === 'object' ? res.data : {};
    } catch (err) {
      if (err instanceof ParticleNotFoundError) return {};
      throw err;
    }
  }

  /** Download the C-CDA ZIP (GET /api/v2/patients/{ppid}/ccda). Stored raw; not parsed in this POC. */
  async getCcdaZip(particlePatientId: string): Promise<Buffer | null> {
    try {
      const res = await this.http.request<ArrayBuffer>({
        method: 'GET',
        path: `/api/v2/patients/${encodeURIComponent(particlePatientId)}/ccda`,
        responseType: 'arraybuffer',
        timeoutMs: CCDA_TIMEOUT_MS,
        label: 'ccda.zip',
      });
      return Buffer.from(res.data);
    } catch (err) {
      if (err instanceof ParticleNotFoundError) return null;
      throw err;
    }
  }

  /**
   * Enrol a patient in Signal monitoring (POST /api/v1/patients/{ppid}/subscriptions).
   * Particle answers 400 when already subscribed; that is treated as success.
   *
   * @returns `true` when newly subscribed, `false` when already subscribed.
   */
  async subscribeMonitoring(particlePatientId: string): Promise<boolean> {
    try {
      await this.http.request<unknown>({
        method: 'POST',
        path: `/api/v1/patients/${encodeURIComponent(particlePatientId)}/subscriptions`,
        // Shape from the Prod-Sandbox Signal Postman collection. Docs also show a bare
        // `{ type: 'MONITORING' }`; confirm with Particle which is canonical.
        body: {
          subscriptions: [
            { particle_patient_id: particlePatientId, type: 'MONITORING' },
          ],
        },
        label: 'signal.subscribe',
      });
      return true;
    } catch (err) {
      if (err instanceof ParticleApiError && err.status === 400) {
        this.logger.log(
          `[Particle] subscribe returned 400; treating as already subscribed ppid=${particlePatientId}`,
        );
        return false;
      }
      throw err;
    }
  }

  /** Stop Signal monitoring (DELETE /api/v2/patients/{ppid}/subscriptions?type=MONITORING). Billing changes apply next month. */
  async unsubscribeMonitoring(particlePatientId: string): Promise<void> {
    try {
      await this.http.request<unknown>({
        method: 'DELETE',
        path: `/api/v2/patients/${encodeURIComponent(particlePatientId)}/subscriptions`,
        params: { type: 'MONITORING' },
        label: 'signal.unsubscribe',
      });
    } catch (err) {
      if (err instanceof ParticleNotFoundError) return;
      throw err;
    }
  }

  /**
   * Sandbox only: ask Particle to fire a simulated Signal workflow to `callbackUrl`.
   * Workflows: ADMIT_/TRANSFER_/DISCHARGE_TRANSITION_ALERT, AI_OUTPUTS, ADT (needs eventType).
   */
  async triggerSandboxWorkflow(
    particlePatientId: string,
    workflow: string,
    callbackUrl: string,
    eventType?: string,
  ): Promise<void> {
    const cfg = this.config.get<ParticleConfig>('particle');
    if (cfg?.env !== 'sandbox') {
      throw new ParticleApiError(
        'Sandbox workflows can only be triggered against the sandbox environment.',
      );
    }
    await this.http.request<unknown>({
      method: 'POST',
      path: `/api/v1/patients/${encodeURIComponent(particlePatientId)}/subscriptions/trigger-sandbox-workflow`,
      body: {
        workflow,
        callback_url: callbackUrl,
        display_name: `elevAID POC - ${workflow}`,
        ...(eventType ? { event_type: eventType } : {}),
      },
      responseType: 'text',
      label: 'signal.sandbox-trigger',
    });
  }
}

const STATE_MAP: Record<string, NormalisedQueryState> = {
  PENDING: 'PENDING',
  SCHEDULED: 'PENDING',
  QUEUED: 'PENDING',
  PROCESSING: 'RUNNING',
  RUNNING: 'RUNNING',
  IN_PROGRESS: 'RUNNING',
  COMPLETE: 'COMPLETE',
  COMPLETED: 'COMPLETE',
  PARTIAL: 'PARTIAL',
  TIMEOUT: 'PARTIAL',
  FAILED: 'FAILED',
  ERROR: 'FAILED',
};

/**
 * Normalise a status body from either documented vocabulary. Accepts a single
 * object or a list (latest entry wins) because the endpoint can return query history.
 */
export function normaliseQueryStatus(body: unknown): ParticleQueryStatus {
  let obj: Record<string, unknown> = {};
  if (Array.isArray(body)) {
    const last: unknown = body[body.length - 1];
    if (last && typeof last === 'object') obj = last as Record<string, unknown>;
  } else if (body && typeof body === 'object') {
    obj = body as Record<string, unknown>;
  }
  const raw = pickString(obj, ['state', 'status', 'query_status']) ?? null;
  const filesRaw = obj.files_available ?? obj.file_count;
  const files =
    filesRaw === undefined || filesRaw === null || filesRaw === ''
      ? null
      : Number(filesRaw);
  return {
    state: raw ? (STATE_MAP[raw.toUpperCase()] ?? 'UNKNOWN') : 'UNKNOWN',
    rawState: raw,
    queryId: pickString(obj, ['query_id', 'id']) ?? null,
    filesAvailable: Number.isFinite(files) ? files : null,
    errorMessage: pickString(obj, ['error_message']) ?? null,
  };
}

function pickString(
  obj: Record<string, unknown>,
  keys: string[],
): string | undefined {
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return undefined;
}

export function isParticleError(err: unknown): err is ParticleError {
  return err instanceof ParticleError;
}
