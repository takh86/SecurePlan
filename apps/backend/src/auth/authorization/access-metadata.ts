/**
 * SP-06 — explicit per-handler access classification.
 *
 * Every route handler must carry exactly one of @Public() or @RequireRoles().
 * Both are METHOD decorators only: class-level exemptions are impossible by
 * type and are additionally rejected by the route-inventory test.
 * Missing or ambiguous classification is denied by AccessControlGuard.
 */
import { SetMetadata } from '@nestjs/common';
import type { TenantRole } from './tenant-context.js';

export const PUBLIC_ACCESS = 'secureplan:access:public';
export const REQUIRED_ROLES = 'secureplan:access:roles';

type HandlerDecorator = (
  target: object,
  propertyKey: string | symbol,
  descriptor: PropertyDescriptor,
) => void;

function handlerOnly(key: string, value: unknown): HandlerDecorator {
  const apply = SetMetadata(key, value);
  return (target, propertyKey, descriptor) => {
    apply(target, propertyKey, descriptor);
  };
}

/** Reviewed public handler. Its own approved contract (Origin, throttling, ...) still applies. */
export function Public(): HandlerDecorator {
  return handlerOnly(PUBLIC_ACCESS, true);
}

/** Authenticated tenant handler, restricted to the listed roles. */
export function RequireRoles(...roles: [TenantRole, ...TenantRole[]]): HandlerDecorator {
  return handlerOnly(REQUIRED_ROLES, Object.freeze([...new Set(roles)]));
}
