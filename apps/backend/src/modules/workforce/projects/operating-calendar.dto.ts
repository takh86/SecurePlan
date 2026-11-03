import { Type } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, ArrayUnique, IsArray, IsBoolean, IsDefined, IsInt, IsObject, IsString, IsUUID, Max, Min, ValidateIf, ValidateNested } from 'class-validator';

export class CalendarVersionDto {
  @IsDefined() @IsUUID() id!: string;
  @IsDefined() @IsInt() @Min(1) @Max(Number.MAX_SAFE_INTEGER) version!: number;
}

export class CalendarQueryDto {
  @IsDefined() @IsString() effectiveForMonth!: string;
}

export class UpdateCalendarDto {
  @IsDefined() @IsString() effectiveFromMonth!: string;
  @ValidateIf((_o, v) => v !== null) @IsDefined() @IsObject() @ValidateNested() @Type(() => CalendarVersionDto)
  expectedExactVersion!: CalendarVersionDto | null;
  @ValidateIf((_o, v) => v !== null) @IsDefined() @IsObject() @ValidateNested() @Type(() => CalendarVersionDto)
  expectedEffective!: CalendarVersionDto | null;
  @ValidateIf((_o, v) => v !== null) @IsDefined() @IsString()
  expectedNextEffectiveFromMonth!: string | null;
  @IsDefined() @IsArray() @ArrayMinSize(1) @ArrayMaxSize(7) @ArrayUnique()
  @IsInt({ each: true }) @Min(1, { each: true }) @Max(7, { each: true })
  operatingWeekdays!: number[];
  @IsDefined() @IsBoolean() bootstrap!: boolean;
}
