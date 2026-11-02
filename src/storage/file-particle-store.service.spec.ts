import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  ELEVAID_1,
  PPID_1,
  PRACTICE_A,
  PRACTICE_B,
  buildConfigService,
  buildLoopRow,
  buildPatientRecord,
} from '../test-utils/builders';
import { FileParticleStore } from './file-particle-store.service';

describe('FileParticleStore', () => {
  let dir: string;
  let store: FileParticleStore;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'particle-store-'));
    store = new FileParticleStore(buildConfigService({ dataDir: dir }));
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('scopes patient records by practice so another tenant cannot read them', async () => {
    await store.upsertPatient(buildPatientRecord());
    await expect(
      store.getPatient({ practiceId: PRACTICE_A, elevaidId: ELEVAID_1 }),
    ).resolves.toMatchObject({ particlePatientId: PPID_1 });
    await expect(
      store.getPatient({ practiceId: PRACTICE_B, elevaidId: ELEVAID_1 }),
    ).resolves.toBeNull();
  });

  it('routes a Particle patient id back to its tenant for webhooks', async () => {
    await store.upsertPatient(buildPatientRecord());
    await expect(store.findByParticlePatientId(PPID_1)).resolves.toEqual({
      practiceId: PRACTICE_A,
      elevaidId: ELEVAID_1,
    });
    await expect(store.findByParticlePatientId('unknown')).resolves.toBeNull();
  });

  it('rejects ids that would escape the data directory', async () => {
    await expect(
      store.getPatient({ practiceId: '../etc', elevaidId: ELEVAID_1 }),
    ).rejects.toThrow('Invalid practiceId');
    await expect(
      store.getPatient({ practiceId: PRACTICE_A, elevaidId: 'a/b' }),
    ).rejects.toThrow('Invalid elevaidId');
  });

  it('tracks active loops and drops them once terminal', async () => {
    await store.saveLoop(buildLoopRow({ status: 'SUBMITTED' }));
    expect(await store.listActiveLoops()).toHaveLength(1);
    await store.saveLoop(buildLoopRow({ status: 'COMPLETE' }));
    expect(await store.listActiveLoops()).toHaveLength(0);
  });

  it('records each webhook event id once', async () => {
    await expect(store.markWebhookEventProcessed('evt-1')).resolves.toBe(true);
    await expect(store.markWebhookEventProcessed('evt-1')).resolves.toBe(false);
  });

  it('keeps concurrent index updates consistent', async () => {
    const results = await Promise.all(
      ['a', 'b', 'c', 'a'].map((id) => store.markWebhookEventProcessed(id)),
    );
    expect(results.filter(Boolean)).toHaveLength(3);
  });

  it('writes raw payloads under the patient folder and appends audit lines', async () => {
    const loc = await store.saveRaw(
      { practiceId: PRACTICE_A, elevaidId: ELEVAID_1 },
      'flat-q-1',
      { labs: [] },
    );
    expect(loc).toContain(
      path.join('practices', PRACTICE_A, 'patients', ELEVAID_1, 'raw'),
    );
    await store.appendAudit({
      at: 'now',
      practiceId: PRACTICE_A,
      elevaidId: ELEVAID_1,
      particlePatientId: PPID_1,
      action: 'QUERY_SUBMIT',
      outcome: 'OK',
    });
    const audit = await fs.readFile(
      path.join(dir, 'audit', 'particle-audit.jsonl'),
      'utf8',
    );
    expect(audit.trim().split('\n')).toHaveLength(1);
  });
});
