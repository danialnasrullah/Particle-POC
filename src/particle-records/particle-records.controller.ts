import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  HttpException,
  HttpStatus,
  Logger,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
  UseGuards,
  UsePipes,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request } from 'express';
import type { ParticleConfig } from '../config/configuration';
import { PocApiKeyGuard } from '../common/guards/poc-api-key.guard';
import { ParticleCallLog } from '../particle/particle-call-log';
import { strictValidationPipe } from '../common/validation';
import {
  DemographicsConflictError,
  ParticleApiError,
  ParticleAuthError,
  ParticleError,
  ParticleNotFoundError,
  ParticleUnavailableError,
  PatientNotRegisteredError,
  RequeryTooSoonError,
  WebhookVerificationError,
} from '../particle/particle.errors';
import type {
  ParticleCloudEvent,
  ParticleFlatResponse,
} from '../particle/particle.types';
import { IngestFlatDto, PullDto, SandboxTriggerDto } from './dto/pull.dto';
import { RegisterPatientDto } from './dto/register-patient.dto';
import { ParticleQueryLoopService } from './particle-query-loop.service';
import { ParticleRecordsService } from './particle-records.service';
import { ParticleWebhookService } from './particle-webhook.service';

type RawBodyRequest = Request & { rawBody?: Buffer };

/**
 * HTTP surface of the POC. Thin: validate, call a service, map errors to `{ detail, code }`.
 * Merge target: redox-backend-nest `src/particle-records/particle-records.controller.ts`.
 */
@Controller('particle-records')
export class ParticleRecordsController {
  private readonly logger = new Logger(ParticleRecordsController.name);

  constructor(
    private readonly records: ParticleRecordsService,
    private readonly loop: ParticleQueryLoopService,
    private readonly webhook: ParticleWebhookService,
    private readonly config: ConfigService,
    private readonly callLog: ParticleCallLog,
  ) {}

  /** Register/update a patient with Particle; optionally enrol in Signal monitoring. */
  @Post('patients')
  @UseGuards(PocApiKeyGuard)
  @UsePipes(strictValidationPipe())
  async register(@Body() dto: RegisterPatientDto) {
    try {
      return await this.records.registerPatient(dto);
    } catch (err) {
      throw this.toHttpException(err);
    }
  }

  /** Physician "Sync": queue a network query. Returns 202 with the loop state. */
  @Post('pull')
  @HttpCode(HttpStatus.ACCEPTED)
  @UseGuards(PocApiKeyGuard)
  @UsePipes(strictValidationPipe())
  async pull(@Body() dto: PullDto) {
    try {
      const row = await this.records.requestPull(
        { practiceId: dto.practiceId, elevaidId: dto.elevaidId },
        dto.requestedBy,
      );
      this.loop.kick();
      return {
        status: row.status,
        queryId: row.queryId,
        nextAttemptAt: row.nextAttemptAt,
      };
    } catch (err) {
      throw this.toHttpException(err);
    }
  }

  @Get('practices/:practiceId/patients/:elevaidId/status')
  @UseGuards(PocApiKeyGuard)
  async status(
    @Param('practiceId', ParseUUIDPipe) practiceId: string,
    @Param('elevaidId', ParseUUIDPipe) elevaidId: string,
  ) {
    try {
      return await this.records.getStatus({ practiceId, elevaidId });
    } catch (err) {
      throw this.toHttpException(err);
    }
  }

  /** Parsed `RedoxParsedData` + Particle extras. Contains PHI. */
  @Get('practices/:practiceId/patients/:elevaidId/parsed')
  @UseGuards(PocApiKeyGuard)
  async parsed(
    @Param('practiceId', ParseUUIDPipe) practiceId: string,
    @Param('elevaidId', ParseUUIDPipe) elevaidId: string,
  ) {
    try {
      return await this.records.getParsed({ practiceId, elevaidId });
    } catch (err) {
      throw this.toHttpException(err);
    }
  }

  @Get('practices/:practiceId/patients/:elevaidId/signal-events')
  @UseGuards(PocApiKeyGuard)
  async signalEvents(
    @Param('practiceId', ParseUUIDPipe) practiceId: string,
    @Param('elevaidId', ParseUUIDPipe) elevaidId: string,
  ) {
    try {
      return await this.records.listSignalEvents({ practiceId, elevaidId });
    } catch (err) {
      throw this.toHttpException(err);
    }
  }

  /** Sandbox only: recent Particle calls for this patient (endpoint, status, response summary), for the test page. */
  @Get('practices/:practiceId/patients/:elevaidId/particle-calls')
  @UseGuards(PocApiKeyGuard)
  async particleCalls(
    @Param('practiceId', ParseUUIDPipe) practiceId: string,
    @Param('elevaidId', ParseUUIDPipe) elevaidId: string,
  ) {
    this.assertSandbox();
    try {
      const { particlePatientId } = await this.records.getStatus({
        practiceId,
        elevaidId,
      });
      return particlePatientId ? this.callLog.list(particlePatientId) : [];
    } catch (err) {
      throw this.toHttpException(err);
    }
  }

  @Delete('practices/:practiceId/patients/:elevaidId/subscription')
  @HttpCode(HttpStatus.NO_CONTENT)
  @UseGuards(PocApiKeyGuard)
  async unsubscribe(
    @Param('practiceId', ParseUUIDPipe) practiceId: string,
    @Param('elevaidId', ParseUUIDPipe) elevaidId: string,
  ) {
    try {
      await this.records.unsubscribe({ practiceId, elevaidId });
    } catch (err) {
      throw this.toHttpException(err);
    }
  }

  /** Dev only: parse + store a Flat payload you already have. Refused outside sandbox. */
  @Post('ingest-flat')
  @UseGuards(PocApiKeyGuard)
  @UsePipes(strictValidationPipe({ forbidNonWhitelisted: false }))
  async ingestFlat(@Body() dto: IngestFlatDto) {
    this.assertSandbox();
    try {
      const row = await this.records.ingestFlat(
        { practiceId: dto.practiceId, elevaidId: dto.elevaidId },
        dto.flat as ParticleFlatResponse,
      );
      return {
        parsedAt: row.parsedAt,
        resourceCounts: row.resourceCounts,
        unmappedTables: row.unmappedTables,
      };
    } catch (err) {
      throw this.toHttpException(err);
    }
  }

  /** Sandbox only: have Particle fire a simulated Signal workflow at our webhook. */
  @Post('sandbox/trigger')
  @HttpCode(HttpStatus.ACCEPTED)
  @UseGuards(PocApiKeyGuard)
  @UsePipes(strictValidationPipe())
  async sandboxTrigger(@Body() dto: SandboxTriggerDto) {
    this.assertSandbox();
    try {
      await this.records.triggerSandbox(
        { practiceId: dto.practiceId, elevaidId: dto.elevaidId },
        dto.workflow,
        dto.callbackUrl,
        dto.eventType,
      );
      return { triggered: dto.workflow };
    } catch (err) {
      throw this.toHttpException(err);
    }
  }

  /**
   * Particle webhook. Authenticated by HMAC signature (not the API key), verified over the
   * raw body captured in main.ts. Always answers quickly; enrichment runs afterwards.
   */
  @Post('webhook')
  @HttpCode(HttpStatus.OK)
  async receiveWebhook(
    @Req() req: RawBodyRequest,
    @Headers('x-ph-signature-256') signature: string | undefined,
    @Body() body: ParticleCloudEvent,
  ) {
    try {
      this.webhook.verifySignature(req.rawBody, signature);
      return await this.webhook.handle(body);
    } catch (err) {
      throw this.toHttpException(err);
    }
  }

  private assertSandbox(): void {
    const cfg = this.config.get<ParticleConfig>('particle');
    if (cfg?.env !== 'sandbox') {
      throw new HttpException(
        {
          detail: 'Only available against the Particle sandbox.',
          code: 'SANDBOX_ONLY',
        },
        HttpStatus.FORBIDDEN,
      );
    }
  }

  private toHttpException(err: unknown): HttpException {
    if (err instanceof HttpException) return err;
    if (err instanceof ParticleError) {
      const body: Record<string, unknown> = {
        detail: err.detail,
        code: err.code,
      };
      if (err instanceof RequeryTooSoonError) {
        body.retryAfter = err.retryAfter.toISOString();
        return new HttpException(body, HttpStatus.CONFLICT);
      }
      if (err instanceof WebhookVerificationError)
        return new HttpException(body, HttpStatus.UNAUTHORIZED);
      if (err instanceof PatientNotRegisteredError)
        return new HttpException(body, HttpStatus.NOT_FOUND);
      if (err instanceof DemographicsConflictError)
        return new HttpException(body, HttpStatus.CONFLICT);
      if (err instanceof ParticleNotFoundError)
        return new HttpException(body, HttpStatus.NOT_FOUND);
      if (err instanceof ParticleUnavailableError)
        return new HttpException(body, HttpStatus.SERVICE_UNAVAILABLE);
      if (err instanceof ParticleAuthError)
        return new HttpException(body, HttpStatus.BAD_GATEWAY);
      if (err instanceof ParticleApiError) {
        const status =
          err.status && err.status >= 400 && err.status < 500
            ? HttpStatus.BAD_REQUEST
            : HttpStatus.BAD_GATEWAY;
        return new HttpException(body, status);
      }
      return new HttpException(body, HttpStatus.INTERNAL_SERVER_ERROR);
    }
    this.logger.error(
      `[Particle Records] unexpected error: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`,
    );
    return new HttpException(
      { detail: 'Unexpected error.', code: 'PARTICLE_UNKNOWN' },
      HttpStatus.INTERNAL_SERVER_ERROR,
    );
  }
}
