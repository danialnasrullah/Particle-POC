import { Controller, Get } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { ParticleConfig } from './config/configuration';

@Controller('health')
export class HealthController {
  constructor(private readonly config: ConfigService) {}

  /** Liveness plus non-secret config flags, so a misconfigured run is obvious. */
  @Get()
  health() {
    const cfg = this.config.get<ParticleConfig>('particle');
    return {
      status: 'ok',
      particleEnv: cfg?.env,
      credentialsConfigured: !!(cfg?.clientId && cfg.clientSecret && cfg.scope),
      webhookSignatureVerification: !!cfg?.webhookSigningKey,
      queryLoopEnabled: cfg?.loop.enabled,
    };
  }
}
