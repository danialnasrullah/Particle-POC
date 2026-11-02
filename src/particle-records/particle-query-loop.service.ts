import {
  Inject,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SchedulerRegistry } from '@nestjs/schedule';
import type { ParticleConfig } from '../config/configuration';
import { ParticleService } from '../particle/particle.service';
import { ParticleUnavailableError } from '../particle/particle.errors';
import { PARTICLE_STORE, type ParticleStore } from '../storage/particle-store';
import { ParticleRecordsService, describe } from './particle-records.service';
import type { QueryLoopRow, QueryLoopStatus } from './particle-records.types';

const INTERVAL_NAME = 'particle-query-tick';
/** Particle needs a moment after submit before status is readable (a 404 is common at first). */
const FIRST_POLL_DELAY_MS = 20_000;
const POLL_BASE_MS = 5_000;
const POLL_MAX_MS = 60_000;
const SUBMIT_RETRY_BASE_MS = 30_000;
const MAX_SUBMIT_ATTEMPTS = 5;
const BATCH_SIZE = 25;

/**
 * Query state machine (replaces Metriport's DQ loop):
 *
 *   QUEUED --submit--> SUBMITTED --poll COMPLETE|PARTIAL--> RETRIEVING --> COMPLETE | NO_DATA
 *                         |  poll FAILED --------------------------------> FAILED
 *                         |  poll errors > budget ------------------------> STALLED
 *                         |  poll ceiling hit -> try retrieval anyway ----> COMPLETE | STALLED
 *
 * A query-complete webhook sets `nextAttemptAt = now` so the next tick polls immediately;
 * polling stays as the safety net when webhooks are missing or delayed.
 *
 * Merge target: redox-backend-nest `src/particle-dq-loop/` (same role as metriport-dq-loop).
 */
@Injectable()
export class ParticleQueryLoopService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ParticleQueryLoopService.name);
  private running = false;

  constructor(
    private readonly particle: ParticleService,
    private readonly records: ParticleRecordsService,
    private readonly config: ConfigService,
    private readonly scheduler: SchedulerRegistry,
    @Inject(PARTICLE_STORE) private readonly store: ParticleStore,
  ) {}

  onModuleInit(): void {
    const cfg = this.cfg();
    if (!cfg.loop.enabled) {
      this.logger.warn(
        '[Particle Loop] disabled by PARTICLE_LOOP_ENABLED=false',
      );
      return;
    }
    const handle = setInterval(() => void this.tick(), cfg.loop.intervalMs);
    this.scheduler.addInterval(INTERVAL_NAME, handle);
    this.logger.log(
      `[Particle Loop] started intervalMs=${cfg.loop.intervalMs}`,
    );
  }

  onModuleDestroy(): void {
    if (this.scheduler.doesExist('interval', INTERVAL_NAME)) {
      this.scheduler.deleteInterval(INTERVAL_NAME);
    }
  }

  /** Run one pass now (used after a pull request or webhook so users do not wait a full interval). */
  kick(): void {
    setImmediate(() => void this.tick());
  }

  /** Called by the webhook handler on a query-complete event. */
  async onQueryComplete(particlePatientId: string): Promise<void> {
    const ref = await this.store.findByParticlePatientId(particlePatientId);
    if (!ref) return;
    const row = await this.store.getLoop(ref);
    if (row && row.status === 'SUBMITTED') {
      await this.save(row, { nextAttemptAt: new Date().toISOString() });
      this.kick();
    }
  }

  /**
   * Process every due loop row once. Re-entrancy safe: overlapping ticks are skipped.
   * Never throws; per-row failures are logged and recorded on the row.
   */
  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const now = Date.now();
      const due = (await this.store.listActiveLoops())
        .filter((r) => new Date(r.nextAttemptAt).getTime() <= now)
        .slice(0, BATCH_SIZE);
      for (const row of due) {
        try {
          await this.step(row);
        } catch (err) {
          this.logger.error(
            `[Particle Loop] step crashed elevaid_id=${row.elevaidId} practice_id=${row.practiceId} status=${row.status}: ${describe(err)}`,
          );
        }
      }
    } catch (err) {
      this.logger.error(`[Particle Loop] tick failed: ${describe(err)}`);
    } finally {
      this.running = false;
    }
  }

  /** Advance one row by one transition. Exposed for tests. */
  async step(row: QueryLoopRow): Promise<QueryLoopRow> {
    switch (row.status) {
      case 'QUEUED':
        return this.submit(row);
      case 'SUBMITTED':
        return this.poll(row);
      case 'RETRIEVING':
        return this.retrieve(row, null);
      default:
        return row;
    }
  }

  private async submit(row: QueryLoopRow): Promise<QueryLoopRow> {
    try {
      const res = await this.particle.submitQuery(row.particlePatientId);
      const now = new Date();
      const next = await this.save(row, {
        status: 'SUBMITTED',
        queryId: res.query_id ?? null,
        submittedAt: now.toISOString(),
        attemptCount: 0,
        pollErrors: 0,
        nextAttemptAt: new Date(
          now.getTime() + FIRST_POLL_DELAY_MS,
        ).toISOString(),
      });
      await this.records.auditQuerySubmit(next, 'OK');
      this.logger.log(
        `[Particle Loop] query submitted elevaid_id=${row.elevaidId} practice_id=${row.practiceId} query_id=${next.queryId ?? 'n/a'}`,
      );
      return next;
    } catch (err) {
      await this.records.auditQuerySubmit(row, 'ERROR', err);
      const attempts = row.attemptCount + 1;
      if (
        err instanceof ParticleUnavailableError &&
        attempts < MAX_SUBMIT_ATTEMPTS
      ) {
        return this.save(row, {
          attemptCount: attempts,
          nextAttemptAt: new Date(
            Date.now() + SUBMIT_RETRY_BASE_MS * 2 ** (attempts - 1),
          ).toISOString(),
        });
      }
      return this.terminal(
        row,
        err instanceof ParticleUnavailableError ? 'STALLED' : 'FAILED',
        `submit: ${describe(err)}`,
      );
    }
  }

  private async poll(row: QueryLoopRow): Promise<QueryLoopRow> {
    const cfg = this.cfg();
    const ceilingMs = cfg.loop.pollCeilingMinutes * 60_000;
    const submittedAt = row.submittedAt
      ? new Date(row.submittedAt).getTime()
      : Date.now();

    let status;
    try {
      status = await this.particle.getQueryStatus(
        row.particlePatientId,
        row.queryId,
      );
    } catch (err) {
      const pollErrors = row.pollErrors + 1;
      this.logger.warn(
        `[Particle Loop] poll error ${pollErrors}/${cfg.loop.maxPollErrors} elevaid_id=${row.elevaidId}: ${describe(err)}`,
      );
      if (pollErrors >= cfg.loop.maxPollErrors) {
        return this.terminal(
          row,
          'STALLED',
          `poll errors exhausted: ${describe(err)}`,
        );
      }
      return this.save(row, {
        pollErrors,
        nextAttemptAt: this.nextPoll(row.attemptCount + pollErrors),
      });
    }

    const patch: Partial<QueryLoopRow> = {
      lastRawState: status.rawState,
      queryId: row.queryId ?? status.queryId,
      attemptCount: row.attemptCount + 1,
    };

    switch (status.state) {
      case 'COMPLETE':
      case 'PARTIAL':
        return this.retrieve(
          await this.save(row, { ...patch, status: 'RETRIEVING' }),
          status.state === 'PARTIAL' ? 'partial results' : null,
        );
      case 'FAILED':
        return this.terminal(
          await this.save(row, patch),
          'FAILED',
          `Particle reported FAILED${status.errorMessage ? `: ${status.errorMessage}` : ''}`,
        );
      default:
        if (Date.now() - submittedAt > ceilingMs) {
          // Particle documents that a timed-out query can still have partial data.
          this.logger.warn(
            `[Particle Loop] poll ceiling reached, trying retrieval anyway elevaid_id=${row.elevaidId}`,
          );
          const r = await this.save(row, { ...patch, status: 'RETRIEVING' });
          return this.retrieve(r, 'poll ceiling reached', 'STALLED');
        }
        return this.save(row, {
          ...patch,
          nextAttemptAt: this.nextPoll(patch.attemptCount ?? 1),
        });
    }
  }

  private async retrieve(
    row: QueryLoopRow,
    note: string | null,
    emptyOutcome: QueryLoopStatus = 'NO_DATA',
  ): Promise<QueryLoopRow> {
    try {
      const outcome = await this.records.retrieveAndParse(row);
      if (outcome === 'COMPLETE') {
        return this.terminal(row, 'COMPLETE', note);
      }
      return this.terminal(
        row,
        emptyOutcome,
        note ?? 'no clinical rows returned',
      );
    } catch (err) {
      const pollErrors = row.pollErrors + 1;
      if (
        err instanceof ParticleUnavailableError &&
        pollErrors < this.cfg().loop.maxPollErrors
      ) {
        return this.save(row, {
          pollErrors,
          nextAttemptAt: this.nextPoll(pollErrors),
        });
      }
      return this.terminal(
        row,
        err instanceof ParticleUnavailableError ? 'STALLED' : 'FAILED',
        `retrieve: ${describe(err)}`,
      );
    }
  }

  private async terminal(
    row: QueryLoopRow,
    status: QueryLoopStatus,
    reason: string | null,
  ): Promise<QueryLoopRow> {
    const next = await this.save(row, {
      status,
      terminalReason: reason,
      completedAt: new Date().toISOString(),
    });
    const log = status === 'COMPLETE' ? 'log' : 'warn';
    this.logger[log](
      `[Particle Loop] ${status} elevaid_id=${row.elevaidId} practice_id=${row.practiceId}${reason ? ` reason="${reason}"` : ''}`,
    );
    return next;
  }

  private async save(
    row: QueryLoopRow,
    patch: Partial<QueryLoopRow>,
  ): Promise<QueryLoopRow> {
    const next: QueryLoopRow = {
      ...row,
      ...patch,
      updatedAt: new Date().toISOString(),
    };
    await this.store.saveLoop(next);
    return next;
  }

  /** Exponential poll backoff: 5s * 1.5^n, capped at 60s (Particle SDK defaults). */
  private nextPoll(attempt: number): string {
    const delay = Math.min(
      POLL_MAX_MS,
      Math.round(POLL_BASE_MS * 1.5 ** Math.max(0, attempt - 1)),
    );
    return new Date(Date.now() + delay).toISOString();
  }

  private cfg(): ParticleConfig {
    const cfg = this.config.get<ParticleConfig>('particle');
    if (!cfg) throw new Error('Particle config block is missing.');
    return cfg;
  }
}
