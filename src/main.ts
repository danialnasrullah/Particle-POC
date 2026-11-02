import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { json, urlencoded } from 'express';
import type { IncomingMessage } from 'node:http';
import { AppModule } from './app.module';
import type { ParticleConfig } from './config/configuration';

/** Flat payloads for long histories and ingest-flat uploads can be large. */
const MAX_BODY_SIZE = '25mb';

async function bootstrap() {
  // Same pattern as redox-backend-nest main.ts: disable Nest's parser and register our own.
  const app = await NestFactory.create(AppModule, { bodyParser: false });

  // Particle posts `application/cloudevents+json`; the default JSON parser ignores that type.
  // `verify` keeps the exact bytes on req.rawBody for HMAC verification of the webhook.
  app.use(
    json({
      limit: MAX_BODY_SIZE,
      type: [
        'application/json',
        'application/cloudevents+json',
        'application/*+json',
      ],
      verify: (req: IncomingMessage & { rawBody?: Buffer }, _res, buf) => {
        req.rawBody = Buffer.from(buf);
      },
    }),
  );
  app.use(urlencoded({ extended: true, limit: MAX_BODY_SIZE }));
  app.enableShutdownHooks();

  const config = app.get(ConfigService);
  const logger = new Logger('Bootstrap');
  const particle = config.get<ParticleConfig>('particle');
  if (particle?.env === 'production' && !particle.allowProduction) {
    logger.error(
      '[Startup] PARTICLE_ENV=production but PARTICLE_ALLOW_PRODUCTION is not true: Particle calls will be refused.',
    );
  }
  if (!particle?.clientId || !particle.clientSecret || !particle.scope) {
    logger.warn(
      '[Startup] Particle credentials not set: only /particle-records/ingest-flat and /health will work.',
    );
  }

  const port = config.get<number>('port') ?? 8100;
  await app.listen(port);
  logger.log(`Particle POC listening on :${port} (env=${particle?.env})`);
}

void bootstrap();
