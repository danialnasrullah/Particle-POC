import {
  CanActivate,
  ExecutionContext,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { timingSafeEqual } from 'node:crypto';
import type { Request } from 'express';

/**
 * Shared-key guard for the POC's internal routes (stands in for the main app's
 * ClinicalServiceApiKeyGuard). Key comes from PARTICLE_POC_API_KEY; when unset the
 * guard allows the call and logs a warning, so local runs work out of the box.
 */
@Injectable()
export class PocApiKeyGuard implements CanActivate {
  private readonly logger = new Logger(PocApiKeyGuard.name);
  private warned = false;

  constructor(private readonly config: ConfigService) {}

  canActivate(ctx: ExecutionContext): boolean {
    const expected = this.config.get<string>('pocApiKey') ?? '';
    if (!expected) {
      if (!this.warned) {
        this.logger.warn(
          '[POC Guard] PARTICLE_POC_API_KEY not set: internal routes are unauthenticated (local only)',
        );
        this.warned = true;
      }
      return true;
    }
    const req = ctx.switchToHttp().getRequest<Request>();
    const got = req.header('x-api-key') ?? '';
    const a = Buffer.from(got);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      throw new UnauthorizedException({
        detail: 'Missing or invalid API key.',
        code: 'UNAUTHORIZED',
      });
    }
    return true;
  }
}
