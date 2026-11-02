/**
 * POC configuration factory.
 *
 * Shape mirrors redox-backend-nest `src/config/configuration.ts`: on merge, the
 * `particle` block below is pasted next to the existing `metriport` block and
 * read the same way (`configService.get<ParticleConfig>('particle')`).
 */
export type ParticleEnv = 'sandbox' | 'production';

export interface ParticleConfig {
  env: ParticleEnv;
  baseUrl: string;
  allowProduction: boolean;
  clientId: string;
  clientSecret: string;
  scope: string;
  webhookSigningKey: string;
  webhookToleranceSeconds: number;
  purposeOfUse: 'TREATMENT' | 'PAYMENT' | 'OPERATIONS';
  requeryMinHours: number;
  loop: {
    enabled: boolean;
    intervalMs: number;
    pollCeilingMinutes: number;
    maxPollErrors: number;
  };
  dataDir: string;
}

const DEFAULT_BASE_URLS: Record<ParticleEnv, string> = {
  sandbox: 'https://sandbox.particlehealth.com',
  production: 'https://api.particlehealth.com',
};

function int(value: string | undefined, fallback: number): number {
  const parsed = parseInt(value ?? '', 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function bool(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value === '') return fallback;
  return value.toLowerCase() === 'true';
}

function purpose(value: string | undefined): ParticleConfig['purposeOfUse'] {
  const v = (value ?? 'TREATMENT').toUpperCase();
  if (v === 'PAYMENT' || v === 'OPERATIONS') return v;
  return 'TREATMENT';
}

export default () => {
  const env: ParticleEnv =
    process.env.PARTICLE_ENV === 'production' ? 'production' : 'sandbox';

  const particle: ParticleConfig = {
    env,
    baseUrl: (process.env.PARTICLE_BASE_URL || DEFAULT_BASE_URLS[env]).replace(
      /\/+$/,
      '',
    ),
    allowProduction: bool(process.env.PARTICLE_ALLOW_PRODUCTION, false),
    clientId: process.env.PARTICLE_CLIENT_ID ?? '',
    clientSecret: process.env.PARTICLE_CLIENT_SECRET ?? '',
    scope: process.env.PARTICLE_SCOPE ?? '',
    webhookSigningKey: process.env.PARTICLE_WEBHOOK_SIGNING_KEY ?? '',
    webhookToleranceSeconds: int(
      process.env.PARTICLE_WEBHOOK_TOLERANCE_SECONDS,
      300,
    ),
    purposeOfUse: purpose(process.env.PARTICLE_PURPOSE_OF_USE),
    requeryMinHours: int(process.env.PARTICLE_REQUERY_MIN_HOURS, 48),
    loop: {
      enabled: bool(process.env.PARTICLE_LOOP_ENABLED, true),
      intervalMs: int(process.env.PARTICLE_LOOP_INTERVAL_MS, 15_000),
      pollCeilingMinutes: int(process.env.PARTICLE_POLL_CEILING_MINUTES, 30),
      maxPollErrors: int(process.env.PARTICLE_MAX_POLL_ERRORS, 5),
    },
    dataDir: process.env.PARTICLE_DATA_DIR ?? './data',
  };

  return {
    port: int(process.env.PORT, 8100),
    pocApiKey: process.env.PARTICLE_POC_API_KEY ?? '',
    particle,
  };
};
