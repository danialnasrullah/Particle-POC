import { createHmac } from 'node:crypto';
import { WebhookVerificationError } from '../particle/particle.errors';
import type { ParticleService } from '../particle/particle.service';
import {
  ELEVAID_1,
  InMemoryParticleStore,
  PPID_1,
  PRACTICE_A,
  buildConfigService,
  buildPatientRecord,
} from '../test-utils/builders';
import { ParticleFlatParserService } from './particle-flat-parser.service';
import type { ParticleQueryLoopService } from './particle-query-loop.service';
import type { ParticleRecordsService } from './particle-records.service';
import { ParticleWebhookService } from './particle-webhook.service';

const KEY = 'whsec_test';

function setup(signingKey = KEY) {
  const store = new InMemoryParticleStore();
  const particle = { getFlatResource: jest.fn(), getFlat: jest.fn() };
  const records = { mergeExtras: jest.fn() };
  const loop = { onQueryComplete: jest.fn() };
  const svc = new ParticleWebhookService(
    buildConfigService({ webhookSigningKey: signingKey }),
    particle as unknown as ParticleService,
    new ParticleFlatParserService(),
    records as unknown as ParticleRecordsService,
    loop as unknown as ParticleQueryLoopService,
    store,
  );
  return { svc, store, particle, records, loop };
}

const sign = (body: string, t = Math.floor(Date.now() / 1000), key = KEY) =>
  `t=${t},${createHmac('sha256', key).update(`${t}.${body}`).digest('hex')}`;

const transitionEvent = {
  specversion: '1.0',
  id: 'evt-1',
  type: 'com.particlehealth.api.v2.transitionalerts',
  subject: 'Admit Alert',
  data: {
    particle_patient_id: PPID_1,
    event_type: 'admission',
    resources: [{ file_id: '', resource_ids: ['transitions/123'] }],
  },
};

describe('ParticleWebhookService', () => {
  describe('verifySignature', () => {
    const body = JSON.stringify(transitionEvent);

    it('accepts a valid signature over the raw body', () => {
      expect(() =>
        setup().svc.verifySignature(Buffer.from(body), sign(body)),
      ).not.toThrow();
    });

    it('accepts any matching signature during key rotation', () => {
      const t = Math.floor(Date.now() / 1000);
      const header = `t=${t},${'0'.repeat(64)},${sign(body, t).split(',')[1]}`;
      expect(() =>
        setup().svc.verifySignature(Buffer.from(body), header),
      ).not.toThrow();
    });

    it('rejects a tampered body, a wrong key, a stale timestamp and a missing header', () => {
      const { svc } = setup();
      expect(() =>
        svc.verifySignature(Buffer.from(body + ' '), sign(body)),
      ).toThrow(WebhookVerificationError);
      expect(() =>
        svc.verifySignature(Buffer.from(body), sign(body, undefined, 'other')),
      ).toThrow(WebhookVerificationError);
      expect(() =>
        svc.verifySignature(
          Buffer.from(body),
          sign(body, Math.floor(Date.now() / 1000) - 3600),
        ),
      ).toThrow(WebhookVerificationError);
      expect(() => svc.verifySignature(Buffer.from(body), undefined)).toThrow(
        WebhookVerificationError,
      );
    });

    it('skips verification only when no signing key is configured', () => {
      expect(() =>
        setup('').svc.verifySignature(undefined, undefined),
      ).not.toThrow();
    });
  });

  it('stores a transition alert, fetches the transition and merges it into the patient record', async () => {
    const { svc, store, particle, records } = setup();
    await store.upsertPatient(buildPatientRecord());
    particle.getFlatResource.mockResolvedValue({
      transitions: [
        { transition_id: '123', status: 'Admission', setting: 'ED' },
      ],
    });

    await expect(svc.handle(transitionEvent)).resolves.toEqual({
      accepted: true,
      routed: true,
    });
    await Promise.all([...svc.pending]);

    expect(particle.getFlatResource).toHaveBeenCalledWith(
      PPID_1,
      'TRANSITIONS',
      '123',
    );
    expect(records.mergeExtras).toHaveBeenCalledWith(
      { practiceId: PRACTICE_A, elevaidId: ELEVAID_1 },
      PPID_1,
      {
        transitions: [
          expect.objectContaining({
            id: '123',
            status: 'admission',
            setting: 'ED',
          }),
        ],
      },
    );
    expect(
      await store.listSignalEvents({
        practiceId: PRACTICE_A,
        elevaidId: ELEVAID_1,
      }),
    ).toHaveLength(1);
  });

  it('processes a redelivered event only once', async () => {
    const { svc, store, particle } = setup();
    await store.upsertPatient(buildPatientRecord());
    particle.getFlatResource.mockResolvedValue({});
    await svc.handle(transitionEvent);
    await expect(svc.handle(transitionEvent)).resolves.toEqual({
      accepted: true,
      duplicate: true,
    });
  });

  it('acknowledges but does not route events for unknown patients', async () => {
    const { svc } = setup();
    await expect(svc.handle(transitionEvent)).resolves.toEqual({
      accepted: true,
      routed: false,
    });
  });

  it('wakes the query loop on a query-complete event', async () => {
    const { svc, store, loop } = setup();
    await store.upsertPatient(buildPatientRecord());
    await svc.handle({
      specversion: '1.0',
      id: 'evt-q',
      type: 'com.particlehealth.api.v2.query',
      data: { patient_id: PPID_1, status: 'COMPLETE', file_count: '3' },
    });
    await Promise.all([...svc.pending]);
    expect(loop.onQueryComplete).toHaveBeenCalledWith(PPID_1);
  });

  it('rejects payloads that are not CloudEvents', async () => {
    await expect(setup().svc.handle({} as never)).rejects.toBeInstanceOf(
      WebhookVerificationError,
    );
  });
});
