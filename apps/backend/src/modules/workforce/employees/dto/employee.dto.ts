/**
 * SP-07 employee request DTOs. The global ValidationPipe (whitelist +
 * forbidNonWhitelisted) rejects every field not declared here, so companyId,
 * accountId, role, status and (on PATCH) email can never be supplied.
 */
import { Transform, Type, type TransformFnParams } from 'class-transformer';
import {
  IsDefined,
  IsEmail,
  IsEnum,
  IsISO8601,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateIf,
} from 'class-validator';
import {
  EmployeeSortField,
  EmployeeStatus,
  ShiftEligibility,
  SortOrder,
} from '../employee.types.js';

/** Business text is trimmed before validation; secrets are never trimmed. */
export function trimString({ value }: TransformFnParams): unknown {
  return typeof value === 'string' ? value.trim() : value;
}

/** PATCH: validate a field only when it was sent (null is then rejected by type). */
const sent = (_object: object, value: unknown): boolean => value !== undefined;
/** PATCH: nullable date fields may be cleared with null. */
const sentNonNull = (_object: object, value: unknown): boolean =>
  value !== undefined && value !== null;

export const EMPLOYEE_CODE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
export const CALENDAR_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export class CreateEmployeeDto {
  @Transform(trimString)
  @IsDefined()
  @IsString()
  @MinLength(1)
  @MaxLength(30)
  @Matches(EMPLOYEE_CODE_PATTERN)
  employeeCode!: string;

  @Transform(trimString)
  @IsDefined()
  @IsString()
  @MinLength(2)
  @MaxLength(50)
  firstName!: string;

  @Transform(trimString)
  @IsDefined()
  @IsString()
  @MinLength(2)
  @MaxLength(50)
  lastName!: string;

  @Transform(trimString)
  @IsDefined()
  @IsString()
  @MaxLength(254)
  @IsEmail()
  email!: string;

  @IsOptional()
  @IsString()
  @Matches(CALENDAR_DATE_PATTERN)
  @IsISO8601({ strict: true })
  employmentStart?: string | null;

  @IsDefined()
  @IsEnum(ShiftEligibility)
  shiftEligibility!: ShiftEligibility;
}

/** E-mail is intentionally absent: login-email changes need their own verified flow. */
export class UpdateEmployeeDto {
  @Transform(trimString)
  @ValidateIf(sent)
  @IsString()
  @MinLength(1)
  @MaxLength(30)
  @Matches(EMPLOYEE_CODE_PATTERN)
  employeeCode?: string;

  @Transform(trimString)
  @ValidateIf(sent)
  @IsString()
  @MinLength(2)
  @MaxLength(50)
  firstName?: string;

  @Transform(trimString)
  @ValidateIf(sent)
  @IsString()
  @MinLength(2)
  @MaxLength(50)
  lastName?: string;

  @ValidateIf(sentNonNull)
  @IsString()
  @Matches(CALENDAR_DATE_PATTERN)
  @IsISO8601({ strict: true })
  employmentStart?: string | null;

  @ValidateIf(sentNonNull)
  @IsString()
  @Matches(CALENDAR_DATE_PATTERN)
  @IsISO8601({ strict: true })
  employmentEnd?: string | null;

  @ValidateIf(sent)
  @IsEnum(ShiftEligibility)
  shiftEligibility?: ShiftEligibility;
}

export class ListEmployeesQueryDto {
  @Transform(trimString)
  @IsOptional()
  @IsString()
  @MinLength(2)
  @MaxLength(100)
  q?: string;

  @IsOptional()
  @IsEnum(EmployeeStatus)
  status?: EmployeeStatus;

  @IsOptional()
  @IsEnum(ShiftEligibility)
  shiftEligibility?: ShiftEligibility;

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

  @IsOptional()
  @IsEnum(EmployeeSortField)
  sortBy?: EmployeeSortField;

  @IsOptional()
  @IsEnum(SortOrder)
  sortOrder?: SortOrder;
}
