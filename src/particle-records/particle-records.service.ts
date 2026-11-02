import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash } from 'node:crypto';
import type { ParticleConfig } from '../config/configuration';
import { ParticleService } from '../particle/particle.service';
import {
  PatientNotRegisteredError,
  RequeryTooSoonError,
} from '../particle/particle.errors';
import type {
  ParticleFhirBundle,
  ParticleFlatResponse,
  ParticlePatientRegistration,
} from '../particle/particle.types';
import { FhirParserService } from '../services/fhir-parser.service';
import { DataSource } from '../types/clinical.types';
import {
  PARTICLE_STORE,
  type ParticleStore,
  type PatientRef,
} from '../storage/particle-store';
import { ParticleFlatParserService } from './particle-flat-parser.service';
import type { RegisterPatientDto } from './dto/register-patient.dto';
import {
  TERMINAL_STATUSES,
  type ParsedRecordRow,
  type ParticleExtras,
  type ParticleParseResult,
  type QueryAuditEntry,
  type QueryLoopRow,
} from './particle-records.types';

/** Copied from redox-backend-nest `MetriportRecordsService.TYPE_TO_BUCKET`: FHIR resourceType -> parser input array. */
const FHIR_TYPE_TO_BUCKET: Record<string, string> = {
  Condition: 'conditions',
  MedicationRequest: 'medications',
  MedicationStatement: 'medicationStatements',
  Medication: 'medicationResources',
  AllergyIntolerance: 'allergies',
  Observation: 'observations',
  Immunization: 'immunizations',
  DiagnosticReport: 'diagnosticReports',
  DocumentReference: 'documentReferences',
  Coverage: 'coverage',
  Procedure: 'procedures',
  Encounter: 'encounters',
  FamilyMemberHistory: 'familyMemberHistories',
  CarePlan: 'carePlans',
  Practitioner: 'practitioners',
  Organization: 'organizations',
};

export interface RegisterResult {
  particlePatientId: string;
  monitoringSubscribed: boolean;
  demographicsChanged: boolean;
}

export interface PatientStatus {
  registered: boolean;
  particlePatientId: string | null;
  monitoringSubscribed: boolean;
  query: Pick<
    QueryLoopRow,
    | 'status'
    | 'queryId'
    | 'lastRawState'
    | 'submittedAt'
    | 'completedAt'
    | 'terminalReason'
    | 'nextAttemptAt'
  > | null;
  parsed: {
    parsedAt: string;
    resourceCounts: Record<string, number>;
    unmappedTables: string[];
  } | null;
}

/**
 * Orchestrates the Particle patient-data flow for elevAID:
 * register -> request pull -> (query loop) -> retrieve FHIR -> store raw -> parse -> store parsed.
 *
 * Merge target: redox-backend-nest `src/particle-records/particle-records.service.ts`.
 * On merge, `persistParsed` is where `dedupService.process` and `buildDedupedForElevaid`
 * get called, exactly as `ingestConsolidatedForPatient` does for Metriport.
 */
@Injectable()
export class ParticleRecordsService {
  private readonly logger = new Logger(ParticleRecordsService.name);

  constructor(
    private readonly particle: ParticleService,
    private readonly parser: ParticleFlatParserService,
    private readonly fhirParser: FhirParserService,
    private readonly config: ConfigService,
    @Inject(PARTICLE_STORE) private readonly store: ParticleStore,
  ) {}

  /**
   * Register or update a patient with Particle and store the mapping.
   *
   * @param dto Validated demographics plus tenant + elevAID ids.
   * @returns Particle id and monitoring state.
   * @throws DemographicsConflictError on a Particle overlay.
   * @throws ParticleError subclasses on upstream failures.
   */
  async registerPatient(dto: RegisterPatientDto): Promise<RegisterResult> {
    const ref: PatientRef = {
      practiceId: dto.practiceId,
      elevaidId: dto.elevaidId,
    };
    const payload = toParticleRegistration(dto);
    const hash = demographicsHash(payload);
    const existing = await this.store.getPatient(ref);

    let particlePatientId: string;
    try {
      const res = await this.particle.registerPatient(payload);
      particlePatientId = res.particle_patient_id;
    } catch (err) {
      await this.audit(
        ref,
        existing?.particlePatientId ?? '',
        'REGISTER',
        'ERROR',
        { requestedBy: dto.requestedBy, err },
      );
      throw err;
    }

    const now = new Date().toISOString();
    let monitoringSubscribed = existing?.monitoringSubscribed ?? false;
    if (dto.subscribeMonitoring && !monitoringSubscribed) {
      try {
        await this.particle.subscribeMonitoring(particlePatientId);
        monitoringSubscribed = true;
        await this.audit(ref, particlePatientId, 'SUBSCRIBE', 'OK', {
          requestedBy: dto.requestedBy,
        });
      } catch (err) {
        // Registration succeeded; a failed subscription is reported, not rolled back.
        this.logger.error(
          `[Particle Records] subscribe failed elevaid_id=${ref.elevaidId} practice_id=${ref.practiceId}: ${describe(err)}`,
        );
        await this.audit(ref, particlePatientId, 'SUBSCRIBE', 'ERROR', {
          requestedBy: dto.requestedBy,
          err,
        });
      }
    }

    await this.store.upsertPatient({
      ...ref,
      particlePatientId,
      demographicsHash: hash,
      monitoringSubscribed,
      registeredAt: existing?.registeredAt ?? now,
      updatedAt: now,
    });
    await this.audit(ref, particlePatientId, 'REGISTER', 'OK', {
      requestedBy: dto.requestedBy,
    });

    this.logger.log(
      `[Particle Records] registered elevaid_id=${ref.elevaidId} practice_id=${ref.practiceId} ppid=${particlePatientId} monitoring=${monitoringSubscribed}`,
    );
    return {
      particlePatientId,
      monitoringSubscribed,
      demographicsChanged: !!existing && existing.demographicsHash !== hash,
    };
  }

  /**
   * Queue a network query for a registered patient. Idempotent while a query is in flight.
   * Enforces Particle's re-query window (default 48h) from the last submitted query.
   *
   * @returns The queued (or already active) loop row.
   * @throws PatientNotRegisteredError when the patient has no Particle mapping.
   * @throws RequeryTooSoonError inside the re-query window.
   */
  async requestPull(
    ref: PatientRef,
    requestedBy: string,
  ): Promise<QueryLoopRow> {
    const patient = await this.store.getPatient(ref);
    if (!patient) {
      throw new PatientNotRegisteredError(
        'Patient is not registered with Particle for this practice.',
      );
    }

    const current = await this.store.getLoop(ref);
    if (current && !TERMINAL_STATUSES.includes(current.status)) {
      return current;
    }

    const cfg = this.config.get<ParticleConfig>('particle');
    const windowMs = (cfg?.requeryMinHours ?? 48) * 3600_000;
    if (current?.submittedAt) {
      const retryAfter = new Date(
        new Date(current.submittedAt).getTime() + windowMs,
      );
      if (retryAfter.getTime() > Date.now() && current.status !== 'FAILED') {
        throw new RequeryTooSoonError(
          `Particle asks not to re-query a patient within ${cfg?.requeryMinHours ?? 48}h. Existing data is available.`,
          retryAfter,
        );
      }
    }

    const now = new Date().toISOString();
    const row: QueryLoopRow = {
      ...ref,
      particlePatientId: patient.particlePatientId,
      status: 'QUEUED',
      queryId: null,
      lastRawState: null,
      attemptCount: 0,
      pollErrors: 0,
      nextAttemptAt: now,
      submittedAt: null,
      completedAt: null,
      terminalReason: null,
      requestedBy,
      createdAt: now,
      updatedAt: now,
    };
    await this.store.saveLoop(row);
    this.logger.log(
      `[Particle Records] pull queued elevaid_id=${ref.elevaidId} practice_id=${ref.practiceId} requested_by=${requestedBy}`,
    );
    return row;
  }

  /**
   * Fetch the FHIR Bundle for a finished query, keep the raw payload, parse and store.
   *
   * @returns `COMPLETE` when clinical rows were found, `NO_DATA` otherwise.
   */
  async retrieveAndParse(row: QueryLoopRow): Promise<'COMPLETE' | 'NO_DATA'> {
    const ref: PatientRef = {
      practiceId: row.practiceId,
      elevaidId: row.elevaidId,
    };
    let bundle: ParticleFhirBundle;
    try {
      bundle = await this.particle.getFhir(row.particlePatientId);
    } catch (err) {
      await this.audit(ref, row.particlePatientId, 'FHIR_RETRIEVE', 'ERROR', {
        queryId: row.queryId,
        requestedBy: row.requestedBy,
        err,
      });
      throw err;
    }
    await this.audit(ref, row.particlePatientId, 'FHIR_RETRIEVE', 'OK', {
      queryId: row.queryId,
      requestedBy: row.requestedBy,
    });

    await this.store.saveRaw(ref, `fhir-${row.queryId ?? 'query'}`, bundle);
    const result = await this.parseFhir(ref.elevaidId, bundle);
    if (!Object.values(result.resourceCounts).some((n) => n > 0)) {
      this.logger.warn(
        `[Particle Records] query finished with no clinical resources elevaid_id=${ref.elevaidId} practice_id=${ref.practiceId}`,
      );
      return 'NO_DATA';
    }
    await this.persistParsed(ref, row.particlePatientId, row.queryId, result);
    return 'COMPLETE';
  }

  /**
   * Parse a FHIR Bundle with the main app's `FhirParserService`, grouping resources
   * exactly as `MetriportRecordsService.groupResourcesForParser` does.
   */
  private async parseFhir(
    elevaidId: string,
    bundle: ParticleFhirBundle,
  ): Promise<ParticleParseResult> {
    // shortcut: reads one Bundle page only; follow `link[next]` if Particle starts paginating /fhir.
    if (bundle.link?.some((l) => l.relation === 'next')) {
      this.logger.warn(
        `[Particle Records] FHIR Bundle has a next page that is not fetched elevaid_id=${elevaidId}`,
      );
    }
    const grouped: Record<string, unknown[]> = {};
    const unmapped = new Set<string>();
    let rawResourceCount = 0;
    for (const e of bundle.entry ?? []) {
      const type = e.resource?.resourceType;
      if (!type) continue;
      rawResourceCount++;
      const bucket = FHIR_TYPE_TO_BUCKET[type];
      if (bucket) (grouped[bucket] ??= []).push(e.resource);
      else unmapped.add(type);
    }
    const clinicalData = await this.fhirParser.parsePatientDataFromResources(
      elevaidId,
      grouped as Record<string, any[]>,
      DataSource.PARTICLE,
    );
    const resourceCounts: Record<string, number> = {};
    for (const [k, v] of Object.entries(clinicalData)) {
      if (Array.isArray(v)) resourceCounts[k] = v.length;
    }
    return {
      clinicalData,
      // Transitions and AI outputs have no FHIR form; they arrive via Signal webhooks (Flat).
      extras: { transitions: [], aiOutputs: [] },
      resourceCounts,
      rawResourceCount,
      unmappedTables: [...unmapped].sort(),
    };
  }

  /**
   * Dev path: parse and store a Flat payload without calling Particle.
   * Used to iterate on the parser with Particle's sample data. Disabled in production.
   */
  async ingestFlat(
    ref: PatientRef,
    flat: ParticleFlatResponse,
  ): Promise<ParsedRecordRow> {
    const patient = await this.store.getPatient(ref);
    await this.store.saveRaw(ref, 'flat-manual-ingest', flat);
    return this.persistParsed(
      ref,
      patient?.particlePatientId ?? 'unregistered',
      null,
      this.parser.parse(ref.elevaidId, flat),
    );
  }

  /** Merge freshly fetched Particle extras (transitions / AI outputs from Signal) into the stored record. */
  async mergeExtras(
    ref: PatientRef,
    particlePatientId: string,
    incoming: Partial<ParticleExtras>,
  ): Promise<void> {
    const existing = await this.store.getParsed(ref);
    const base: ParsedRecordRow = existing ?? {
      ...ref,
      particlePatientId,
      queryId: null,
      parsedAt: new Date().toISOString(),
      clinicalData: { patientId: ref.elevaidId },
      extras: { transitions: [], aiOutputs: [] },
      resourceCounts: {},
      rawResourceCount: 0,
      unmappedTables: [],
    };
    const upsert = <T extends { id: string }>(
      current: T[],
      add: T[] | undefined,
    ): T[] => {
      const byId = new Map(current.map((x) => [x.id, x]));
      for (const x of add ?? []) byId.set(x.id, x);
      return [...byId.values()];
    };
    base.extras = {
      transitions: upsert(base.extras.transitions, incoming.transitions),
      aiOutputs: upsert(base.extras.aiOutputs, incoming.aiOutputs),
    };
    base.resourceCounts = {
      ...base.resourceCounts,
      transitions: base.extras.transitions.length,
      aiOutputs: base.extras.aiOutputs.length,
    };
    await this.store.saveParsed(base);
  }

  /** Status for the dashboard: registration, current query and parsed summary. No clinical data. */
  async getStatus(ref: PatientRef): Promise<PatientStatus> {
    const [patient, loop, parsed] = await Promise.all([
      this.store.getPatient(ref),
      this.store.getLoop(ref),
      this.store.getParsed(ref),
    ]);
    return {
      registered: !!patient,
      particlePatientId: patient?.particlePatientId ?? null,
      monitoringSubscribed: patient?.monitoringSubscribed ?? false,
      query: loop
        ? {
            status: loop.status,
            queryId: loop.queryId,
            lastRawState: loop.lastRawState,
            submittedAt: loop.submittedAt,
            completedAt: loop.completedAt,
            terminalReason: loop.terminalReason,
            nextAttemptAt: loop.nextAttemptAt,
          }
        : null,
      parsed: parsed
        ? {
            parsedAt: parsed.parsedAt,
            resourceCounts: parsed.resourceCounts,
            unmappedTables: parsed.unmappedTables,
          }
        : null,
    };
  }

  async getParsed(ref: PatientRef): Promise<ParsedRecordRow> {
    const parsed = await this.store.getParsed(ref);
    if (!parsed) {
      throw new PatientNotRegisteredError(
        'No parsed Particle data for this patient.',
      );
    }
    return parsed;
  }

  async listSignalEvents(ref: PatientRef): Promise<unknown[]> {
    return this.store.listSignalEvents(ref);
  }

  /** Stop Signal monitoring and record it. */
  async unsubscribe(ref: PatientRef, requestedBy?: string): Promise<void> {
    const patient = await this.store.getPatient(ref);
    if (!patient)
      throw new PatientNotRegisteredError(
        'Patient is not registered with Particle for this practice.',
      );
    await this.particle.unsubscribeMonitoring(patient.particlePatientId);
    await this.store.upsertPatient({
      ...patient,
      monitoringSubscribed: false,
      updatedAt: new Date().toISOString(),
    });
    await this.audit(ref, patient.particlePatientId, 'UNSUBSCRIBE', 'OK', {
      requestedBy,
    });
  }

  async triggerSandbox(
    ref: PatientRef,
    workflow: string,
    callbackUrl: string,
    eventType?: string,
  ): Promise<void> {
    const patient = await this.store.getPatient(ref);
    if (!patient)
      throw new PatientNotRegisteredError(
        'Patient is not registered with Particle for this practice.',
      );
    await this.particle.triggerSandboxWorkflow(
      patient.particlePatientId,
      workflow,
      callbackUrl,
      eventType,
    );
  }

  /** Record a query-loop action (submit) in the audit log. Used by the loop service. */
  async auditQuerySubmit(
    row: QueryLoopRow,
    outcome: 'OK' | 'ERROR',
    err?: unknown,
  ): Promise<void> {
    await this.audit(
      { practiceId: row.practiceId, elevaidId: row.elevaidId },
      row.particlePatientId,
      'QUERY_SUBMIT',
      outcome,
      { queryId: row.queryId, requestedBy: row.requestedBy, err },
    );
  }

  private async persistParsed(
    ref: PatientRef,
    particlePatientId: string,
    queryId: string | null,
    result: ParticleParseResult,
  ): Promise<ParsedRecordRow> {
    const previous = await this.store.getParsed(ref);
    // Keep Signal-delivered extras that a full pull may not include yet.
    const keepById = <T extends { id: string }>(
      fresh: T[],
      old: T[] | undefined,
    ): T[] => {
      const byId = new Map((old ?? []).map((x) => [x.id, x]));
      for (const x of fresh) byId.set(x.id, x);
      return [...byId.values()];
    };
    const extras: ParticleExtras = {
      transitions: keepById(
        result.extras.transitions,
        previous?.extras.transitions,
      ),
      aiOutputs: keepById(result.extras.aiOutputs, previous?.extras.aiOutputs),
    };
    const row: ParsedRecordRow = {
      ...ref,
      particlePatientId,
      queryId,
      parsedAt: new Date().toISOString(),
      clinicalData: result.clinicalData,
      extras,
      resourceCounts: {
        ...result.resourceCounts,
        transitions: extras.transitions.length,
        aiOutputs: extras.aiOutputs.length,
      },
      rawResourceCount: result.rawResourceCount,
      unmappedTables: result.unmappedTables,
    };
    await this.store.saveParsed(row);
    this.logger.log(
      `[Particle Records] parsed elevaid_id=${ref.elevaidId} practice_id=${ref.practiceId} rows=${result.rawResourceCount} counts=${JSON.stringify(row.resourceCounts)}`,
    );
    return row;
  }

  private async audit(
    ref: PatientRef,
    particlePatientId: string,
    action: QueryAuditEntry['action'],
    outcome: 'OK' | 'ERROR',
    extra: {
      requestedBy?: string | null;
      queryId?: string | null;
      err?: unknown;
    } = {},
  ): Promise<void> {
    const cfg = this.config.get<ParticleConfig>('particle');
    try {
      await this.store.appendAudit({
        at: new Date().toISOString(),
        ...ref,
        particlePatientId,
        action,
        purposeOfUse:
          action === 'QUERY_SUBMIT' ||
          action === 'FLAT_RETRIEVE' ||
          action === 'FHIR_RETRIEVE'
            ? cfg?.purposeOfUse
            : undefined,
        requestedBy: extra.requestedBy ?? null,
        queryId: extra.queryId ?? null,
        outcome,
        detail: extra.err ? describe(extra.err) : undefined,
      });
    } catch (err) {
      // Audit failure must be visible but must not mask the business outcome.
      this.logger.error(
        `[Particle Records] [RECONCILIATION REQUIRED] audit write failed action=${action} elevaid_id=${ref.elevaidId}: ${describe(err)}`,
      );
    }
  }
}

/** Map our DTO to Particle's registration body. */
export function toParticleRegistration(
  dto: RegisterPatientDto,
): ParticlePatientRegistration {
  const digits = dto.phone?.replace(/\D/g, '').replace(/^1(?=\d{10}$)/, '');
  return {
    patient_id: dto.elevaidId,
    given_name: dto.firstName.trim(),
    family_name: dto.lastName.trim(),
    date_of_birth: dto.dob,
    gender: dto.genderAtBirth === 'F' ? 'FEMALE' : 'MALE',
    address_city: dto.address.city.trim(),
    address_state: dto.address.state.toUpperCase(),
    postal_code: dto.address.zip,
    ...(dto.address.lines?.length
      ? { address_lines: dto.address.lines.map((l) => l.trim()) }
      : {}),
    ...(digits && digits.length === 10
      ? {
          telephone: `${digits.slice(0, 3)}-${digits.slice(3, 6)}-${digits.slice(6)}`,
        }
      : {}),
    ...(dto.email ? { email: dto.email.trim() } : {}),
  };
}

/** Stable SHA-256 over the registration body (keys sorted), used to detect demographic changes. */
export function demographicsHash(payload: ParticlePatientRegistration): string {
  const sorted = Object.keys(payload)
    .sort()
    .reduce<Record<string, unknown>>((acc, k) => {
      acc[k] = (payload as unknown as Record<string, unknown>)[k];
      return acc;
    }, {});
  return createHash('sha256').update(JSON.stringify(sorted)).digest('hex');
}

/** Error summary safe for logs/audit: class + code + message. Our error messages never contain PHI. */
export function describe(err: unknown): string {
  if (err && typeof err === 'object' && 'code' in err && err instanceof Error) {
    return `${err.name}(${String((err as { code: unknown }).code)}): ${err.message}`;
  }
  return err instanceof Error ? `${err.name}: ${err.message}` : String(err);
}
