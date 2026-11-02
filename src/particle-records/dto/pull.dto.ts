import {
  IsIn,
  IsNotEmpty,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  IsUrl,
  MaxLength,
} from 'class-validator';

export class PatientRefDto {
  @IsUUID()
  practiceId!: string;

  @IsUUID()
  elevaidId!: string;
}

/** Physician-triggered pull (the "Sync" button). */
export class PullDto extends PatientRefDto {
  /**
   * Physician/user id with the treatment relationship. Required: purpose-of-use
   * TREATMENT queries must be attributable to a treating clinician.
   */
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  requestedBy!: string;
}

/** Dev-only: parse and store a Flat payload you already have (e.g. Particle's sample data). */
export class IngestFlatDto extends PatientRefDto {
  @IsObject()
  flat!: Record<string, unknown>;
}

export const SANDBOX_WORKFLOWS = [
  'ADMIT_TRANSITION_ALERT',
  'TRANSFER_TRANSITION_ALERT',
  'DISCHARGE_TRANSITION_ALERT',
  'NEW_ENCOUNTER_ALERT',
  'DISCHARGE_SUMMARY_ALERT',
  'AI_OUTPUTS',
  'ADT',
] as const;

export class SandboxTriggerDto extends PatientRefDto {
  @IsIn(SANDBOX_WORKFLOWS as unknown as string[])
  workflow!: string;

  /** Public HTTPS URL that reaches POST /particle-records/webhook (e.g. an ngrok tunnel). */
  @IsUrl({ protocols: ['https'], require_protocol: true })
  callbackUrl!: string;

  @IsOptional()
  @IsIn(['A01', 'A02', 'A03', 'A04', 'A08'])
  eventType?: string;
}
