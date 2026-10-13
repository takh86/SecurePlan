import {
  IsDefined,
  IsString,
  IsNotEmpty,
  MinLength,
  MaxLength,
} from 'class-validator';

export class ActivateAccountDto {
  @IsDefined()
  @IsString()
  @IsNotEmpty()
  token!: string;

  @IsDefined()
  @IsString()
  @MinLength(15)
  @MaxLength(128)
  password!: string;
}
