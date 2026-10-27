/**
 * SP-08b shift-configuration request DTOs. The global ValidationPipe (whitelist
 * + forbidNonWhitelisted) rejects every undeclared field, also inside each
 * shift rule, so companyId, ids or timestamps can never be supplied. Syntax
 * only here: the first-of-month rule (INVALID_MONTH_START), the time relation
 * and the month lower bound (SHIFT_CONFIGURATION_INVALID) are service rules.
 */
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsDefined,
  IsEnum,
  IsISO8601,
  IsString,
  Matches,
  ValidateNested,
} from 'class-validator';
import { CALENDAR_DATE_PATTERN } from '../../employees/dto/employee.dto.js';
import { ShiftKind } from '../shift-configuration.types.js';

/** Canonical API local time (ADR-0003): HH:mm, 24-hour clock; no seconds, no 24:00. */
export const LOCAL_TIME_PATTERN = /^(?:[01]\d|2[0-3]):[0-5]\d$/;

export class ShiftConfigurationQueryDto {
  /** Required: the read is month-scoped (effective configuration for that month). */
  @IsDefined()
  @IsString()
  @Matches(CALENDAR_DATE_PATTERN)
  @IsISO8601({ strict: true })
  effectiveForMonth!: string;
}

export class ShiftRuleInputDto {
  @IsDefined()
  @IsEnum(ShiftKind)
  shiftKind!: ShiftKind;

  @IsDefined()
  @IsString()
  @Matches(LOCAL_TIME_PATTERN)
  startLocal!: string;

  @IsDefined()
  @IsString()
  @Matches(LOCAL_TIME_PATTERN)
  endLocal!: string;
}

/** Full replacement of the shift set of one effective month (O-5). */
export class UpdateShiftConfigurationDto {
  @IsDefined()
  @IsString()
  @Matches(CALENDAR_DATE_PATTERN)
  @IsISO8601({ strict: true })
  effectiveFromMonth!: string;

  @IsDefined()
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(2)
  // No silent deduplication: a repeated shift kind is a DUPLICATE_ITEM error.
  @ArrayUnique((rule: unknown) => (rule as { shiftKind?: unknown } | null)?.shiftKind)
  @ValidateNested({ each: true })
  @Type(() => ShiftRuleInputDto)
  shifts!: ShiftRuleInputDto[];
}
