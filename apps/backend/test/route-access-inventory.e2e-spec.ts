/**
 * SP-06 — every RUNTIME route must carry an explicit access classification.
 *
 * Routes are read from the live Express router after app.init() and joined to
 * the Nest handler metadata. The test fails when a registered route has no
 * classified handler, a handler is unclassified/ambiguous, a controller class
 * carries access metadata, or the reviewed public allowlist changes.
 */
import { Test } from '@nestjs/testing';
import { RequestMethod, type INestApplication, type Type } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants.js';
import { DiscoveryModule, DiscoveryService, MetadataScanner } from '@nestjs/core';
import { vi } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { DatabaseService } from '../src/database/database.service.js';
import { PASSWORD_DENYLIST } from '../src/auth/local-password-denylist.js';
import { configureApp } from '../src/configure-app.js';
import { PUBLIC_ACCESS, REQUIRED_ROLES } from '../src/auth/authorization/access-metadata.js';
import {
  AuthorizationProbeController,
  ClassLevelPublicProbeController,
} from './helpers/authorization-probe.controller.js';

/** Reviewed public surface. Changing it requires an explicit review decision. */
const PUBLIC_ALLOWLIST = [
  'GET /',
  'GET /api/v1/health/live',
  'GET /api/v1/health/ready',
  'POST /api/v1/auth/activate',
  'POST /api/v1/auth/login',
].sort();

type Classification = 'PUBLIC' | 'ROLES' | 'UNCLASSIFIED' | 'AMBIGUOUS' | 'CLASS_LEVEL';

type HandlerRoute = { key: string; classification: Classification; roles?: readonly string[] };

type ExpressLayer = {
  route?: { path: string | string[]; methods: Record<string, boolean> };
  handle?: { stack?: unknown[] };
  name?: string;
};

function normalize(...parts: string[]): string {
  const joined = parts
    .flatMap((part) => part.split('/'))
    .filter((segment) => segment.length > 0)
    .join('/');
  return `/${joined}`;
}

function asArray(value: unknown): string[] {
  if (value === undefined) return [''];
  const values: unknown[] = Array.isArray(value) ? value : [value];
  return values.map((item) => {
    if (typeof item !== 'string') throw new Error('Unsupported (non-string) route path metadata');
    return item;
  });
}

function runtimeRoutes(app: INestApplication): string[] {
  const express = app.getHttpAdapter().getInstance() as { router: { stack: ExpressLayer[] } };
  const routes: string[] = [];
  for (const layer of express.router.stack) {
    if (!layer.route) {
      // A mounted sub-router would hide its paths from this inventory.
      if (layer.name === 'router' || layer.handle?.stack) {
        throw new Error('Nested Express routers are not supported by the route inventory');
      }
      continue;
    }
    for (const path of asArray(layer.route.path)) {
      for (const method of Object.keys(layer.route.methods)) {
        if (method === '_all') throw new Error(`Catch-all route registered at ${path}`);
        routes.push(`${method.toUpperCase()} ${normalize(path)}`);
      }
    }
  }
  return routes.sort();
}

function handlerRoutes(app: INestApplication): HandlerRoute[] {
  const discovery = app.get(DiscoveryService);
  const scanner = app.get(MetadataScanner);
  const result: HandlerRoute[] = [];
  for (const wrapper of discovery.getControllers()) {
    const metatype = wrapper.metatype as Type<unknown> | undefined;
    if (!metatype) continue;
    const classLevel =
      Reflect.getMetadata(PUBLIC_ACCESS, metatype) !== undefined ||
      Reflect.getMetadata(REQUIRED_ROLES, metatype) !== undefined;
    const controllerPaths = asArray(Reflect.getMetadata(PATH_METADATA, metatype));

    for (const name of scanner.getAllMethodNames(metatype.prototype)) {
      const handler = (metatype.prototype as Record<string, unknown>)[name] as object;
      const methodPath = Reflect.getMetadata(PATH_METADATA, handler) as unknown;
      const method = Reflect.getMetadata(METHOD_METADATA, handler) as RequestMethod | undefined;
      if (methodPath === undefined || method === undefined) continue; // not a route handler

      const isPublic = Reflect.getMetadata(PUBLIC_ACCESS, handler) === true;
      const roles = Reflect.getMetadata(REQUIRED_ROLES, handler) as readonly string[] | undefined;
      const classification: Classification = classLevel ? 'CLASS_LEVEL'
        : isPublic && roles !== undefined ? 'AMBIGUOUS'
          : isPublic ? 'PUBLIC'
            : roles !== undefined && roles.length > 0 ? 'ROLES'
              : 'UNCLASSIFIED';

      for (const controllerPath of controllerPaths) {
        for (const path of asArray(methodPath)) {
          result.push({
            key: `${RequestMethod[method]} ${normalize(controllerPath, path)}`,
            classification,
            roles,
          });
        }
      }
    }
  }
  return result.sort((a, b) => a.key.localeCompare(b.key));
}

async function boot(controllers: Type<unknown>[] = []): Promise<INestApplication> {
  const moduleFixture = await Test.createTestingModule({
    imports: [AppModule, DiscoveryModule],
    controllers,
  })
    .overrideProvider(DatabaseService)
    .useValue({ isReady: vi.fn().mockResolvedValue(true) })
    .overrideProvider(PASSWORD_DENYLIST)
    .useValue(new Set<string>())
    .compile();
  const app = moduleFixture.createNestApplication();
  configureApp(app);
  await app.init();
  return app;
}

describe('SP-06 — runtime route access inventory', () => {
  it('F17: every AppModule runtime route is explicitly and unambiguously classified', async () => {
    const app = await boot();
    try {
      const runtime = runtimeRoutes(app);
      const handlers = handlerRoutes(app);
      const byKey = new Map(handlers.map((h) => [h.key, h]));

      // Sanity: the inventory really sees the live application.
      expect(runtime).toContain('GET /api/v1/me');
      expect(runtime.length).toBeGreaterThanOrEqual(7);

      const unmatched = runtime.filter((key) => !byKey.has(key));
      expect(unmatched).toEqual([]);
      expect(handlers.map((h) => h.key).sort()).toEqual(runtime);

      const violations = handlers
        .filter((h) => h.classification !== 'PUBLIC' && h.classification !== 'ROLES')
        .map((h) => `${h.key}: ${h.classification}`);
      expect(violations).toEqual([]);

      const publicRoutes = handlers.filter((h) => h.classification === 'PUBLIC').map((h) => h.key).sort();
      expect(publicRoutes).toEqual(PUBLIC_ALLOWLIST);

      // Protected identity routes are open to both tenant roles; never PLATFORM_ADMIN.
      expect(byKey.get('GET /api/v1/me')?.roles).toEqual(['EMPLOYEE', 'COMPANY_ADMIN']);
      expect(byKey.get('POST /api/v1/auth/logout')?.roles).toEqual(['EMPLOYEE', 'COMPANY_ADMIN']);

      // SP-07: employee administration is COMPANY_ADMIN-only, on every route.
      const employeeRoutes = handlers.filter((h) => h.key.includes(' /api/v1/employees'));
      expect(employeeRoutes.map((h) => h.key)).toEqual([
        'GET /api/v1/employees',
        'GET /api/v1/employees/:employeeId',
        'PATCH /api/v1/employees/:employeeId',
        'POST /api/v1/employees',
        'POST /api/v1/employees/:employeeId/deactivate',
      ]);
      for (const route of employeeRoutes) {
        expect({ route: route.key, roles: route.roles }).toEqual({ route: route.key, roles: ['COMPANY_ADMIN'] });
      }

      // SP-08: project administration is COMPANY_ADMIN-only, on every route.
      const projectRoutes = handlers.filter((h) => h.key.includes(' /api/v1/projects'));
      expect(projectRoutes.map((h) => h.key)).toEqual([
        'GET /api/v1/projects',
        'GET /api/v1/projects/:projectId',
        'PATCH /api/v1/projects/:projectId',
        'POST /api/v1/projects',
      ]);
      for (const route of projectRoutes) {
        expect({ route: route.key, roles: route.roles }).toEqual({ route: route.key, roles: ['COMPANY_ADMIN'] });
      }
      for (const handler of handlers) {
        expect(handler.roles ?? []).not.toContain('PLATFORM_ADMIN');
      }
    } finally {
      await app.close();
    }
  });

  it('detects unclassified, ambiguous and class-level metadata (inventory self-test)', async () => {
    const app = await boot([AuthorizationProbeController, ClassLevelPublicProbeController]);
    try {
      const violations = handlerRoutes(app)
        .filter((h) => h.classification !== 'PUBLIC' && h.classification !== 'ROLES')
        .map((h) => `${h.key}: ${h.classification}`)
        .sort();
      expect(violations).toEqual([
        'GET /test-only/authz-class-public: CLASS_LEVEL',
        'GET /test-only/authz-probe/ambiguous: AMBIGUOUS',
        'GET /test-only/authz-probe/unclassified: UNCLASSIFIED',
        'POST /test-only/authz-probe/unclassified: UNCLASSIFIED',
      ]);
      expect(runtimeRoutes(app)).toEqual(handlerRoutes(app).map((h) => h.key).sort());
    } finally {
      await app.close();
    }
  });
});
