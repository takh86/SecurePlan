import { Body, Controller, HttpCode, Post } from '@nestjs/common';
import { ActivateAccountDto } from './dto/activate-account.dto.js';
import { AuthService } from './auth.service.js';

@Controller('api/v1/auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Post('activate')
  @HttpCode(200)
  activate(@Body() activateAccountDto: ActivateAccountDto) {
    return this.authService.activate(activateAccountDto);
  }
}
