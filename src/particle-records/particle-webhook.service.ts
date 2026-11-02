import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { ParticleConfig } from '../config/configuration';
import { ParticleService } from '../particle/particle.service';
import { WebhookVerificationError } from '../particle/particle.errors';
import {
  PARTICLE_EVENT_TYPES,
  type AiOutputsData,
  type ParticleCloudEvent,
  type QueryCompleteData,
  type TransitionAlertData,
} from '../particle/particle.types';
import {
  PARTICLE_STORE,
  type ParticleStore,
  type PatientRef,
} from '../storage/particle-store';
import { ParticleFlatParserService } from './particle-flat-parser.service';
import { ParticleQueryLoopService } from './particle-query-loop.service';
import { ParticleRecordsService, describe } from './particle-records.service';

export interface WebhookAck {
  accepted: boolean;
  duplicate?: boolean;
  routed?: boolean;
}

/**
 * Inbound Particle Signal / query webhooks (CloudEvents 1.0).
 *
 * The request path only verifies, de-duplicates, routes and stores the event, then
 * acknowledges (Particle expects 200 within 30s). Fetching the referenced data runs
 * after the response. Unlike the Metriport edge, nothing here is forwarded unauthenticated.
 */
@Injectable()
export class ParticleWebhookService {
  private readonly logger = new Logger(ParticleWebhookService.name);
  /** Background enrichment promises; awaited in tests. */
  readonly pending = new Set<Promise<void>>();

  constructor(
    private readonly config: ConfigService,
    private readonly particle: ParticleService,
    private readonly parser: ParticleFlatParserService,
    private readonly records: ParticleRecordsService,
    private readonly loop: ParticleQueryLoopService,
    @Inject(PARTICLE_STORE) private readonly store: ParticleStore,
  ) {}

  /**
   * Verify `X-Ph-Signature-256: t=<unix>,<hex sig>[,<hex sig>...]` over `"{t}.{raw body}"`.
   * Multiple signatures may be present during key rotation; any match passes.
   *
   * @throws WebhookVerificationError when the header is missing, stale or does not match.
   */
  verifySignature(
    rawBody: Buffer | undefined,
    header: string | undefined,
  ): void {
    const cfg = this.config.get<ParticleConfig>('particle');
    const key = cfg?.webhookSigningKey ?? '';
    if (!key) {
      this.logger.warn(
        '[Particle Webhook] PARTICLE_WEBHOOK_SIGNING_KEY not set: signature NOT verified (local testing only)',
      );
      return;
    }
    if (!rawBody || !header) {
      throw new WebhookVerificationError('Missing webhook signature or body.');
    }
    const parts = header
      .split(',')
      .map((p) => p.trim())
      .filter(Boolean);
    const tPart = parts.find((p) => p.startsWith('t='));
    const timestamp = tPart ? Number(tPart.slice(2)) : NaN;
    if (!Number.isFinite(timestamp)) {
      throw new WebhookVerificationError('Malformed webhook signature header.');
    }
    const tolerance = cfg?.webhookToleranceSeconds ?? 300;
    if (Math.abs(Date.now() / 1000 - timestamp) > tolerance) {
      throw new WebhookVerificationError(
        'Webhook signature timestamp outside tolerance.',
      );
    }
    const digest = createHmac('sha256', key)
      .update(`${tPart!.slice(2)}.`)
      .update(rawBody)
      .digest();
    // Docs do not state the encoding; accept hex (expected) or base64. Confirm with Particle.
    const expected = [digest.toString('hex'), digest.toString('base64')];
    const candidates = parts
      .filter((p) => p !== tPart)
      .map((p) => (/^v\d+=/.test(p) ? p.slice(p.indexOf('=') + 1) : p));
    const ok = candidates.some((sig) =>
      expected.some((exp, i) =>
        safeEqual(i === 0 ? sig.toLowerCase() : sig, exp),
      ),
    );
    if (!ok) {
      throw new WebhookVerificationError('Webhook signature mismatch.');
    }
  }

  /**
   * Accept a verified event: de-duplicate on CloudEvent `id`, route to the tenant,
   * store it, and schedule enrichment.
   */
  async handle(event: ParticleCloudEvent): Promise<WebhookAck> {
    if (!event?.id || !event.type) {
      throw new WebhookVerificationError(
        'Payload is not a CloudEvent (missing id/type).',
      );
    }
    const fresh = await this.store.markWebhookEventProcessed(event.id);
    if (!fresh) {
      this.logger.log(
        `[Particle Webhook] duplicate event ignored id=${event.id} type=${event.type}`,
      );
      return { accepted: true, duplicate: true };
    }

    const ppid = readParticlePatientId(event);
    const ref = ppid ? await this.store.findByParticlePatientId(ppid) : null;
    if (!ref) {
      // Unknown patient: acknowledge so Particle does not retry forever, but flag it.
      this.logger.warn(
        `[Particle Webhook] [RECONCILIATION REQUIRED] no local patient for event id=${event.id} type=${event.type} ppid=${ppid ?? 'none'}`,
      );
      return { accepted: true, routed: false };
    }

    await this.store.saveSignalEvent(ref, event.id, {
      receivedAt: new Date().toISOString(),
      id: event.id,
      type: event.type,
      subject: event.subject,
      time: event.time,
      data: event.data,
    });
    this.logger.log(
      `[Particle Webhook] accepted id=${event.id} type=${event.type} elevaid_id=${ref.elevaidId} practice_id=${ref.practiceId}`,
    );

    const job = this.enrich(ref, ppid!, event)
      .catch((err) => {
        this.logger.error(
          `[Particle Webhook] [RECONCILIATION REQUIRED] enrichment failed id=${event.id} type=${event.type} elevaid_id=${ref.elevaidId}: ${describe(err)}`,
        );
      })
      .finally(() => this.pending.delete(job));
    this.pending.add(job);

    return { accepted: true, routed: true };
  }

  private async enrich(
    ref: PatientRef,
    ppid: string,
    event: ParticleCloudEvent,
  ): Promise<void> {
    switch (event.type) {
      case PARTICLE_EVENT_TYPES.QUERY:
      case PARTICLE_EVENT_TYPES.QUERY_V1:
        await this.loop.onQueryComplete(ppid);
        return;

      case PARTICLE_EVENT_TYPES.TRANSITION: {
        const data = (event.data ?? {}) as TransitionAlertData;
        const ids = (data.resources ?? [])
          .flatMap((r) => r.resource_ids ?? [])
          .filter((id) => /^transitions?\//i.test(id))
          .map((id) => id.split('/')[1])
          .filter(Boolean);
        for (const id of [...new Set(ids)]) {
          const flat = await this.particle.getFlatResource(
            ppid,
            'TRANSITIONS',
            id,
          );
          const { extras } = this.parser.parse(ref.elevaidId, flat);
          await this.records.mergeExtras(ref, ppid, {
            transitions: extras.transitions,
          });
        }
        return;
      }

      case PARTICLE_EVENT_TYPES.AI_OUTPUTS:
      case PARTICLE_EVENT_TYPES.AI_OUTPUT: {
        const data = (event.data ?? {}) as AiOutputsData;
        const done = (data.outputs ?? []).filter(
          (o) => o.status !== 'failed',
        ).length;
        if (data.outputs && done === 0) return;
        const flat = await this.particle.getFlat(ppid, [
          'AI_OUTPUTS',
          'AI_CITATIONS',
        ]);
        const { extras } = this.parser.parse(ref.elevaidId, flat);
        await this.records.mergeExtras(ref, ppid, {
          aiOutputs: extras.aiOutputs,
        });
        return;
      }

      default:
        // Stored above; HL7v2, encounter, consent and medication-fill alerts are not enriched in the POC.
        return;
    }
  }
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

/** Query-complete events may carry the id in particle_patient_id, patient_id or person_id. */
export function readParticlePatientId(
  event: ParticleCloudEvent,
): string | null {
  const d = (event.data ?? {}) as QueryCompleteData & TransitionAlertData;
  for (const v of [d.particle_patient_id, d.patient_id, d.person_id]) {
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return null;
}
