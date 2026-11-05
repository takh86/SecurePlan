/** Generated public employee DTO surface only; no internal schema or operational parameters. */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const ref = (name) => ({ $ref: `#/components/schemas/${name}` });
const uuid = { type: 'string', format: 'uuid' },
  instant = { type: 'string', format: 'date-time' },
  millis = {
    ...instant,
    pattern:
      '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\\.[0-9]{3}Z$',
  },
  nullable = (v) => ({ anyOf: [v, { type: 'null' }] });
const integer = {
  type: 'integer',
  minimum: 0,
  maximum: Number.MAX_SAFE_INTEGER,
};
const object = (properties) => ({
  type: 'object',
  additionalProperties: false,
  required: Object.keys(properties),
  properties,
});
const array = (items) => ({ type: 'array', items });
const schema = {
  Employee: object({
    id: uuid,
    employeeCode: { type: 'string' },
    firstName: { type: 'string' },
    lastName: { type: 'string' },
  }),
  Duty: object({
    id: uuid,
    dutyDate: { type: 'string', format: 'date' },
    shiftKind: { enum: ['DAY', 'NIGHT'] },
    startsAt: instant,
    endsAt: instant,
  }),
  Offer: object({
    id: uuid,
    needId: uuid,
    employee: ref('Employee'),
    status: {
      enum: ['OPEN', 'SELECTED', 'NOT_SELECTED', 'INVALIDATED', 'WITHDRAWN'],
    },
    createdAt: millis,
    decidedAt: nullable(millis),
  }),
  Need: object({
    id: uuid,
    cancellationRequestId: uuid,
    duty: ref('Duty'),
    status: { enum: ['OPEN', 'OPEN_UNFILLED', 'RESOLVED', 'CLOSED'] },
    resolvedAt: nullable(millis),
    openOfferCount: integer,
    project: object({ id: uuid, name: { type: 'string' } }),
    timeZone: { type: 'string' },
  }),
  NeedPage: object({
    items: array(
      object({ need: ref('Need'), myOffer: nullable(ref('Offer')) }),
    ),
    pagination: object({
      page: { ...integer, minimum: 1 },
      pageSize: { type: 'integer', minimum: 1, maximum: 100 },
      totalItems: integer,
      totalPages: integer,
    }),
  }),
  Cancellation: object({
    id: uuid,
    assignmentId: uuid,
    employee: ref('Employee'),
    duty: ref('Duty'),
    status: { enum: ['OPEN', 'WITHDRAWN', 'REJECTED', 'APPROVED', 'OBSOLETE'] },
    createdAt: instant,
    decidedAt: nullable(instant),
    replacementNeed: object({
      id: uuid,
      status: { enum: ['OPEN', 'OPEN_UNFILLED', 'RESOLVED', 'CLOSED'] },
      resolvedAt: nullable(instant),
    }),
  }),
  WorkItems: object({
    cancellationRequests: array(ref('Cancellation')),
    replacementOffers: array(ref('Offer')),
  }),
};
schema.Offer.allOf = [
  {
    if: { properties: { status: { const: 'OPEN' } } },
    then: { properties: { decidedAt: { type: 'null' } } },
    else: { properties: { decidedAt: millis } },
  },
];
schema.Need.allOf = [
  {
    if: { properties: { status: { const: 'RESOLVED' } } },
    then: { properties: { resolvedAt: millis } },
    else: { properties: { resolvedAt: { type: 'null' } } },
  },
];
const month = {
  name: 'monthStart',
  in: 'query',
  required: true,
  schema: { type: 'string', pattern: '^[0-9]{4}-[0-9]{2}-01$' },
  description: 'Real civil first day, years 0001 through 9999.',
};
const needId = { name: 'needId', in: 'path', required: true, schema: uuid };
const responses = (status, name) => ({
  [status]: {
    description: 'Current authenticated employee result.',
    headers: { 'Cache-Control': { schema: { const: 'private, no-store' } } },
    content: { 'application/json': { schema: ref(name) } },
  },
  ...Object.fromEntries(
    [400, 401, 403, 404, 409, 500].map((code) => [
      code,
      {
        description:
          'Existing RFC 9457 problem contract; private, no-store; resource concealment applies.',
      },
    ]),
  ),
});
const api = {
  openapi: '3.1.0',
  info: {
    title: 'SecurePlan employee replacement offers',
    version: 'SP18-P2',
    description:
      'Approved employee surface of issue #34. An offer is voluntary and does not assign the employee. No candidate list or administrative decision endpoints. Work-items keeps both collection keys; loaded older clients require a coordinated refresh before enabling writes.',
  },
  security: [{ session: [] }],
  paths: {
    '/api/v1/me/replacement-needs': {
      get: {
        operationId: 'listEligibleReplacementNeeds',
        parameters: [
          month,
          {
            name: 'page',
            in: 'query',
            schema: { type: 'integer', minimum: 1, default: 1 },
          },
          {
            name: 'pageSize',
            in: 'query',
            schema: { type: 'integer', minimum: 1, maximum: 100, default: 25 },
          },
        ],
        responses: responses(200, 'NeedPage'),
      },
    },
    '/api/v1/replacement-needs/{needId}': {
      parameters: [needId],
      get: {
        operationId: 'getEligibleReplacementNeed',
        responses: responses(200, 'Need'),
      },
    },
    '/api/v1/replacement-needs/{needId}/offers': {
      parameters: [needId],
      post: {
        operationId: 'createReplacementOffer',
        'x-bodyless': true,
        description:
          'EMPLOYEE only. No request body or query. Current identity is server-derived. Same-key retry returns the current owned result, including terminal status, with Idempotency-Replayed: true.',
        parameters: [
          {
            name: 'Idempotency-Key',
            in: 'header',
            required: true,
            schema: {
              type: 'string',
              minLength: 8,
              maxLength: 128,
              pattern: '^[!-~]+$',
            },
          },
          {
            name: 'X-CSRF-Token',
            in: 'header',
            required: true,
            schema: { type: 'string' },
          },
        ],
        responses: responses(201, 'Offer'),
      },
    },
    '/api/v1/me/work-items': {
      get: {
        operationId: 'getOwnWorkItems',
        parameters: [month],
        responses: responses(200, 'WorkItems'),
      },
    },
  },
  components: {
    securitySchemes: {
      session: {
        type: 'apiKey',
        in: 'cookie',
        name: '__Host-secureplan_session',
      },
    },
    schemas: schema,
  },
};
const target = fileURLToPath(
  new URL('../docs/api/replacement-offers.openapi.json', import.meta.url),
);
const output = JSON.stringify(api, null, 2) + '\n';
if (process.argv.includes('--check')) {
  if (readFileSync(target, 'utf8').replaceAll('\r\n', '\n') !== output)
    throw new Error('Generated employee replacement API contract is stale');
  console.log('Employee replacement OpenAPI contract matches its generator.');
} else writeFileSync(target, output);
