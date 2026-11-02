import { Module } from '@nestjs/common';
import { ParticleModule } from '../particle/particle.module';
import { StorageModule } from '../storage/storage.module';
import { FhirParserService } from '../services/fhir-parser.service';
import { PocApiKeyGuard } from '../common/guards/poc-api-key.guard';
import { ParticleFlatParserService } from './particle-flat-parser.service';
import { ParticleQueryLoopService } from './particle-query-loop.service';
import { ParticleRecordsController } from './particle-records.controller';
import { ParticleRecordsService } from './particle-records.service';
import { ParticleWebhookService } from './particle-webhook.service';

/** Orchestration, parsing, query loop and webhooks. Merge target: redox-backend-nest `src/particle-records/`. */
@Module({
  imports: [ParticleModule, StorageModule],
  controllers: [ParticleRecordsController],
  providers: [
    ParticleFlatParserService,
    FhirParserService,
    ParticleRecordsService,
    ParticleQueryLoopService,
    ParticleWebhookService,
    PocApiKeyGuard,
  ],
  exports: [ParticleRecordsService, ParticleFlatParserService],
})
export class ParticleRecordsModule {}
