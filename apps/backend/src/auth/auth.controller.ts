import {
  Body,
  Controller,
  HttpCode,
  Post,
  UseGuards,
} from '@nestjs/common';

import { ThrottlerGuard } from '@nestjs/throttler';

import { CorrelationId } from '../common/http/correlation-id.decorator.js';
import { ActivateAccountDto } from './dto/activate-account.dto.js';
import { AuthService } from './auth.service.js';
import { Public } from './authorization/access-metadata.js';

@Controller('api/v1/auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Post('activate')
  @HttpCode(200)
  @Public()
  @UseGuards(ThrottlerGuard)
  activate(
    @Body() activateAccountDto: ActivateAccountDto,
    @CorrelationId() correlationId: string,
  ) {
    return this.authService.activate(activateAccountDto, correlationId);
  }
}