import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { ParticleAuthService } from './particle-auth.service';
import { ParticleCallLog } from './particle-call-log';
import { ParticleHttpService } from './particle-http.service';
import { ParticleService } from './particle.service';

/** Particle API client layer. Merge target: redox-backend-nest `src/particle/` (ParticleCallLog is POC-only). */
@Module({
  imports: [HttpModule],
  providers: [
    ParticleAuthService,
    ParticleHttpService,
    ParticleService,
    ParticleCallLog,
  ],
  exports: [ParticleService, ParticleCallLog],
})
export class ParticleModule {}
