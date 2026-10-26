/**
 * SP-09 project-assignment request DTOs. The global ValidationPipe (whitelist +
 * forbidNonWhitelisted) rejects every undeclared field, so companyId or any
 * tenant/ownership hint can never be supplied. Syntax only here: a valid date
 * that is not the first of a month is rejected by the service with the
 * dedicated code INVALID_MONTH_START (Phase 8.5).
 */
import { Type } from 'class-transformer';
import {
  IsDefined,
  IsISO8601,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  Min,
} from 'class-validator';
import { CALENDAR_DATE_PATTERN } from '../../employees/dto/employee.dto.js';

export class CreateProjectAssignmentDto {
  @IsDefined()
  @IsUUID('all')
  employeeId!: string;

  @IsDefined()
  @IsUUID('all')
  projectId!: string;

  @IsDefined()
  @IsString()
  @Matches(CALENDAR_DATE_PATTERN)
  @IsISO8601({ strict: true })
  monthStart!: string;
}

export class ListProjectAssignmentsQueryDto {
  /** Required: the resource is month-scoped (Phase 8.8). */
  @IsDefined()
  @IsString()
  @Matches(CALENDAR_DATE_PATTERN)
  @IsISO8601({ strict: true })
  monthStart!: string;

  @IsOptional()
  @IsUUID('all')
  projectId?: string;

  @IsOptional()
  @IsUUID('all')
  employeeId?: string;

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
