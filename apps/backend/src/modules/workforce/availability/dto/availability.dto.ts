import { IsDefined, IsEnum, IsISO8601, IsString, Matches, ValidateIf } from 'class-validator';
import { AvailabilityOperation, AvailabilityStatus, ConflictPolicy } from '../availability.types.js';

const DATE = /^(?!0000)\d{4}-\d{2}-\d{2}$/;
const sent = (_object: object, value: unknown) => value !== undefined;
export class AvailabilityMonthQueryDto {
  @IsDefined() @IsString() @Matches(DATE) @IsISO8601({ strict: true })
  monthStart!: string;
}
export class AvailabilitySelectionDto {
  @IsDefined() @IsEnum(AvailabilityOperation)
  operation!: AvailabilityOperation;
  @IsDefined() @IsString() @Matches(DATE) @IsISO8601({ strict: true })
  fromDate!: string;
  @IsDefined() @IsString() @Matches(DATE) @IsISO8601({ strict: true })
  toDate!: string;
  @ValidateIf((object: AvailabilitySelectionDto, value: unknown) => object.operation === AvailabilityOperation.SET || value !== undefined)
  @IsDefined() @IsEnum(AvailabilityStatus)
  status?: AvailabilityStatus;
  @ValidateIf(sent) @IsEnum(ConflictPolicy)
  conflictPolicy?: ConflictPolicy;
}
export class AvailabilityCommitDto extends AvailabilitySelectionDto {
  @IsDefined() @IsString() @Matches(/^[A-Za-z0-9_-]{43}$/)
  previewToken!: string;
  // Combination validation belongs to the domain boundary, with its approved code.
  @ValidateIf(sent) @IsString()
  confirmation?: string;
}
