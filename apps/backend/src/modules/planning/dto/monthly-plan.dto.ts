/**
 * SP-11 request DTOs (Phase 8.3/8.4, first slice per SP11A-R1 T5). The global
 * ValidationPipe (whitelist + forbidNonWhitelisted) rejects every undeclared
 * field, nested ones included, so companyId, status, UTC instants, version,
 * source, publishedAt or a time zone can never be supplied by the client.
 *
 * Syntax only here. Service rules: a real civil date (400 INVALID_DATE), the
 * first day of a month (400 INVALID_MONTH_START) and a duty date inside the
 * plan month (400 DUTY_DATE_OUTSIDE_PLAN_MONTH). No staffing minimum and no
 * business roster maximum exist (Phase 8.4, K2): the roster is bounded only by
 * the existing 100 KiB JSON body limit (413 REQUEST_BODY_TOO_LARGE), a
 * technical safeguard; every roster check is a set-based statement.
 */
import { Type } from 'class-transformer';
import {
  ArrayUnique,
  IsArray,
  IsDefined,
  IsEnum,
  IsISO8601,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  Min,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import { CALENDAR_DATE_PATTERN } from '../../workforce/employees/dto/employee.dto.js';
import { ShiftKind } from '../../workforce/shift-configurations/shift-configuration.types.js';
import { DutyRole, MonthlyPlanStatus } from '../monthly-plan.types.js';

export class ListMonthlyPlansQueryDto {
  @IsOptional()
  @IsUUID('all')
  projectId?: string;

  @IsOptional()
  @IsString()
  @Matches(CALENDAR_DATE_PATTERN)
  @IsISO8601({ strict: true })
  monthStart?: string;

  @IsOptional()
  @IsEnum(MonthlyPlanStatus)
  status?: MonthlyPlanStatus;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(1_000_000)
  page?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  pageSize?: number;
}

export class CreateMonthlyPlanDto {
  @IsDefined()
  @IsUUID('all')
  projectId!: string;

  @IsDefined()
  @IsString()
  @Matches(CALENDAR_DATE_PATTERN)
  @IsISO8601({ strict: true })
  monthStart!: string;
}

export class DutyAssignmentInputDto {
  @IsDefined()
  @IsUUID('all')
  employeeId!: string;

  @IsDefined()
  @IsEnum(DutyRole)
  dutyRole!: DutyRole;
}

/** Omitted means no members; null is rejected (only `undefined` skips validation). */
const sent = (_object: object, value: unknown): boolean => value !== undefined;

export class CreateMonthlyPlanEntryDto {
  @IsDefined()
  @IsString()
  @Matches(CALENDAR_DATE_PATTERN)
  @IsISO8601({ strict: true })
  dutyDate!: string;

  @IsDefined()
  @IsEnum(ShiftKind)
  shiftKind!: ShiftKind;

  @ValidateIf(sent)
  @IsArray()
  // ValidateNested recurses into arrays, including an empty array with no
  // children to validate. Require one object at each roster position first.
  @IsObject({ each: true })
  // No silent deduplication: the same employee twice (any letter case) is DUPLICATE_ITEM.
  @ArrayUnique((item: unknown) => {
    const id = (item as { employeeId?: unknown } | null)?.employeeId;
    return typeof id === 'string' ? id.toLowerCase() : id;
  })
  @ValidateNested({ each: true })
  @Type(() => DutyAssignmentInputDto)
  assignments?: DutyAssignmentInputDto[];
}

export class ListMonthlyPlanEntriesQueryDto {
  @IsOptional()
  @IsEnum(ShiftKind)
  shiftKind?: ShiftKind;
}
