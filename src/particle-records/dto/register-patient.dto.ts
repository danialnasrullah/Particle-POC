import { Type } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsEmail,
  IsIn,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Matches,
  MaxLength,
  ValidateNested,
} from 'class-validator';

const US_STATES = [
  'AL',
  'AK',
  'AZ',
  'AR',
  'CA',
  'CO',
  'CT',
  'DE',
  'DC',
  'FL',
  'GA',
  'HI',
  'ID',
  'IL',
  'IN',
  'IA',
  'KS',
  'KY',
  'LA',
  'ME',
  'MD',
  'MA',
  'MI',
  'MN',
  'MS',
  'MO',
  'MT',
  'NE',
  'NV',
  'NH',
  'NJ',
  'NM',
  'NY',
  'NC',
  'ND',
  'OH',
  'OK',
  'OR',
  'PA',
  'RI',
  'SC',
  'SD',
  'TN',
  'TX',
  'UT',
  'VT',
  'VA',
  'WA',
  'WV',
  'WI',
  'WY',
  'PR',
  'GU',
  'VI',
  'AS',
  'MP',
];

export class PatientAddressDto {
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  @MaxLength(200, { each: true })
  lines?: string[];

  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  city!: string;

  /** Two-letter abbreviation. Particle rejects full names ("Massachusetts"). */
  @IsIn(US_STATES)
  state!: string;

  @Matches(/^\d{5}(-\d{4})?$/, { message: 'zip must be 5 or 9 digits' })
  zip!: string;
}

/**
 * Register (or update) an elevAID patient with Particle.
 * Field names follow the main app's CreatePatientDto (firstName/lastName/dob/genderAtBirth)
 * so the primary backend can send the same payload it sends for Metriport.
 */
export class RegisterPatientDto {
  /** Tenant. Every stored row is scoped by this. */
  @IsUUID()
  practiceId!: string;

  /** elevAID patient UUID. Sent to Particle as `patient_id`. */
  @IsUUID()
  elevaidId!: string;

  @IsString()
  @Length(1, 100)
  firstName!: string;

  @IsString()
  @Length(1, 100)
  lastName!: string;

  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'dob must be YYYY-MM-DD' })
  dob!: string;

  /** Particle accepts MALE/FEMALE only. */
  @IsIn(['M', 'F'])
  genderAtBirth!: 'M' | 'F';

  @ValidateNested()
  @Type(() => PatientAddressDto)
  address!: PatientAddressDto;

  @IsOptional()
  @Matches(/^\+?1?[-. ]?\(?\d{3}\)?[-. ]?\d{3}[-. ]?\d{4}$/, {
    message: 'phone must be a US number',
  })
  phone?: string;

  @IsOptional()
  @IsEmail()
  email?: string;

  /** Also enrol in Signal monitoring (ADT alerts, AI outputs). Billed per patient per month. */
  @IsOptional()
  @IsBoolean()
  subscribeMonitoring?: boolean;

  /** User/physician id recorded in the audit log. */
  @IsOptional()
  @IsString()
  @MaxLength(100)
  requestedBy?: string;
}
