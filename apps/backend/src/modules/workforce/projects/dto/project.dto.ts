/**
 * SP-08 project request DTOs (API v1: name + status only). The global
 * ValidationPipe (whitelist + forbidNonWhitelisted) rejects every undeclared
 * field, so companyId, id or an ARCHIVED status can never be supplied.
 */
import { Transform, Type } from 'class-transformer';
import {
  IsDefined,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateIf,
} from 'class-validator';
import { trimString } from '../../employees/dto/employee.dto.js';
import { SortOrder } from '../../employees/employee.types.js';
import { ProjectSortField, ProjectStatus } from '../project.types.js';

/** PATCH: validate a field only when it was sent (null is then rejected by type). */
const sent = (_object: object, value: unknown): boolean => value !== undefined;

export class CreateProjectDto {
  @Transform(trimString)
  @IsDefined()
  @IsString()
  @MinLength(2)
  @MaxLength(100)
  name!: string;
}

export class UpdateProjectDto {
  @Transform(trimString)
  @ValidateIf(sent)
  @IsString()
  @MinLength(2)
  @MaxLength(100)
  name?: string;

  @ValidateIf(sent)
  @IsEnum(ProjectStatus)
  status?: ProjectStatus;
}

export class ListProjectsQueryDto {
  @Transform(trimString)
  @IsOptional()
  @IsString()
  @MinLength(2)
  @MaxLength(100)
  q?: string;

  @IsOptional()
  @IsEnum(ProjectStatus)
  status?: ProjectStatus;

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
  @IsEnum(ProjectSortField)
  sortBy?: ProjectSortField;

  @IsOptional()
  @IsEnum(SortOrder)
  sortOrder?: SortOrder;
}
