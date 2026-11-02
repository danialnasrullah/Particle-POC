import type { SchedulerRegistry } from '@nestjs/schedule';
import {
  ParticleApiError,
  ParticleUnavailableError,
} from '../particle/particle.errors';
import type { ParticleService } from '../particle/particle.service';
import {
  InMemoryParticleStore,
  buildConfigService,
  buildLoopRow,
  buildPatientRecord,
  PPID_1,
} from '../test-utils/builders';
import { ParticleQueryLoopService } from './particle-query-loop.service';
import type { ParticleRecordsService } from './particle-records.service';

function setup() {
  const store = new InMemoryParticleStore();
  const particle = { submitQuery: jest.fn(), getQueryStatus: jest.fn() };
  const records = { retrieveAndParse: jest.fn(), auditQuerySubmit: jest.fn() };
  const loop = new ParticleQueryLoopService(
    particle as unknown as ParticleService,
    records as unknown as ParticleRecordsService,
    buildConfigService(),
    {} as SchedulerRegistry,
    store,
  );
  return { store, particle, records, loop };
}

const status = (state: string) => ({
  state,
  rawState: state,
  queryId: 'q1',
  filesAvailable: null,
  errorMessage: null,
});

describe('ParticleQueryLoopService', () => {
  it('submits a queued query and schedules the first poll', async () => {
    const { loop, particle, records } = setup();
    particle.submitQuery.mockResolvedValue({ query_id: 'q1' });
    const next = await loop.step(buildLoopRow());
    expect(next).toMatchObject({ status: 'SUBMITTED', queryId: 'q1' });
    expect(new Date(next.nextAttemptAt).getTime()).toBeGreaterThan(Date.now());
    expect(records.auditQuerySubmit).toHaveBeenCalledWith(
      expect.anything(),
      'OK',
    );
  });

  it('retries a submit when Particle is unavailable, then stalls after the budget', async () => {
    const { loop, particle } = setup();
    particle.submitQuery.mockRejectedValue(
      new ParticleUnavailableError('down'),
    );
    const retry = await loop.step(buildLoopRow());
    expect(retry).toMatchObject({ status: 'QUEUED', attemptCount: 1 });
    const stalled = await loop.step(buildLoopRow({ attemptCount: 4 }));
    expect(stalled.status).toBe('STALLED');
  });

  it('fails a submit that Particle rejects outright', async () => {
    const { loop, particle } = setup();
    particle.submitQuery.mockRejectedValue(new ParticleApiError('bad', 422));
    expect((await loop.step(buildLoopRow())).status).toBe('FAILED');
  });

  it('keeps polling while the query is running', async () => {
    const { loop, particle } = setup();
    particle.getQueryStatus.mockResolvedValue(status('RUNNING'));
    const next = await loop.step(
      buildLoopRow({
        status: 'SUBMITTED',
        submittedAt: new Date().toISOString(),
      }),
    );
    expect(next).toMatchObject({
      status: 'SUBMITTED',
      attemptCount: 1,
      lastRawState: 'RUNNING',
    });
  });

  it('retrieves and completes when the query is complete', async () => {
    const { loop, particle, records } = setup();
    particle.getQueryStatus.mockResolvedValue(status('COMPLETE'));
    records.retrieveAndParse.mockResolvedValue('COMPLETE');
    const next = await loop.step(
      buildLoopRow({
        status: 'SUBMITTED',
        submittedAt: new Date().toISOString(),
      }),
    );
    expect(next.status).toBe('COMPLETE');
  });

  it('ends as NO_DATA when Particle finds nothing', async () => {
    const { loop, particle, records } = setup();
    particle.getQueryStatus.mockResolvedValue(status('COMPLETE'));
    records.retrieveAndParse.mockResolvedValue('NO_DATA');
    expect(
      (await loop.step(buildLoopRow({ status: 'SUBMITTED' }))).status,
    ).toBe('NO_DATA');
  });

  it('marks the row FAILED when Particle reports a failed query', async () => {
    const { loop, particle } = setup();
    particle.getQueryStatus.mockResolvedValue(status('FAILED'));
    expect(
      (await loop.step(buildLoopRow({ status: 'SUBMITTED' }))).status,
    ).toBe('FAILED');
  });

  it('stalls after the poll error budget', async () => {
    const { loop, particle } = setup();
    particle.getQueryStatus.mockRejectedValue(
      new ParticleUnavailableError('down'),
    );
    const next = await loop.step(
      buildLoopRow({ status: 'SUBMITTED', pollErrors: 2 }),
    );
    expect(next.status).toBe('STALLED');
  });

  it('tries retrieval anyway when the poll ceiling is reached', async () => {
    const { loop, particle, records } = setup();
    particle.getQueryStatus.mockResolvedValue(status('RUNNING'));
    records.retrieveAndParse.mockResolvedValue('COMPLETE');
    const longAgo = new Date(Date.now() - 31 * 60_000).toISOString();
    const next = await loop.step(
      buildLoopRow({ status: 'SUBMITTED', submittedAt: longAgo }),
    );
    expect(next).toMatchObject({
      status: 'COMPLETE',
      terminalReason: 'poll ceiling reached',
    });
  });

  it('makes a submitted row due immediately on a query-complete webhook', async () => {
    const { loop, store } = setup();
    await store.upsertPatient(buildPatientRecord());
    const future = new Date(Date.now() + 60_000).toISOString();
    await store.saveLoop(
      buildLoopRow({ status: 'SUBMITTED', nextAttemptAt: future }),
    );
    jest.spyOn(loop, 'kick').mockImplementation(() => undefined);
    await loop.onQueryComplete(PPID_1);
    const row = (await store.listActiveLoops())[0];
    expect(new Date(row.nextAttemptAt).getTime()).toBeLessThanOrEqual(
      Date.now(),
    );
  });

  it('only processes rows that are due, and never throws from a tick', async () => {
    const { loop, store, particle } = setup();
    await store.saveLoop(
      buildLoopRow({
        nextAttemptAt: new Date(Date.now() + 60_000).toISOString(),
      }),
    );
    await loop.tick();
    expect(particle.submitQuery).not.toHaveBeenCalled();
  });
});
