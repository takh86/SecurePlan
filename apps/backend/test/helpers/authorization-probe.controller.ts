/**
 * SP-06 TEST-ONLY probe routes. Registered exclusively inside test modules,
 * never in AppModule, to exercise the global AccessControlGuard before any
 * business resource exists. Records handler invocations so tests can prove
 * that denied requests never reach a handler.
 */
import { Body, Controller, Get, Post, SetMetadata } from '@nestjs/common';
import { IsOptional, IsString, MaxLength } from 'class-validator';
import { PUBLIC_ACCESS, Public, RequireRoles } from '../../src/auth/authorization/access-metadata.js';
import { CurrentTenant } from '../../src/auth/authorization/current-tenant.decorator.js';
import type { TenantContext } from '../../src/auth/authorization/tenant-context.js';

export const probeCalls: string[] = [];

export class ProbeWriteDto {
  @IsOptional()
  @IsString()
  @MaxLength(50)
  note?: string;
}

@Controller('test-only/authz-probe')
export class AuthorizationProbeController {
  @Get('admin')
  @RequireRoles('COMPANY_ADMIN')
  adminRead(@CurrentTenant() tenant: TenantContext) {
    probeCalls.push('adminRead');
    return tenant;
  }

  @Post('admin')
  @RequireRoles('COMPANY_ADMIN')
  adminWrite(@CurrentTenant() tenant: TenantContext, @Body() dto: ProbeWriteDto) {
    probeCalls.push('adminWrite');
    return { tenant, note: dto.note ?? null };
  }

  @Get('employee')
  @RequireRoles('EMPLOYEE')
  employeeRead(@CurrentTenant() tenant: TenantContext) {
    probeCalls.push('employeeRead');
    return tenant;
  }

  @Get('unclassified')
  unclassifiedRead() {
    probeCalls.push('unclassifiedRead');
    return { reached: true };
  }

  @Post('unclassified')
  unclassifiedWrite() {
    probeCalls.push('unclassifiedWrite');
    return { reached: true };
  }

  @Get('ambiguous')
  @Public()
  @RequireRoles('EMPLOYEE')
  ambiguousRead() {
    probeCalls.push('ambiguousRead');
    return { reached: true };
  }
}

/** Simulates a class-level exemption attempt; must have no effect. */
@SetMetadata(PUBLIC_ACCESS, true)
@Controller('test-only/authz-class-public')
export class ClassLevelPublicProbeController {
  @Get()
  read() {
    probeCalls.push('classLevelPublicRead');
    return { reached: true };
  }
}
