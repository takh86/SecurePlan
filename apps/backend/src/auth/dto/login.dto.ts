import { IsDefined, IsEmail, IsNotEmpty, IsString, MaxLength } from 'class-validator';

export class LoginDto {
  @IsDefined()
  @IsString()
  @IsEmail()
  @MaxLength(320)
  email!: string;

  // No minimum password length on login: a bad password gets neutral 401.
  @IsDefined()
  @IsString()
  @IsNotEmpty()
  @MaxLength(1024)
  password!: string;
}
