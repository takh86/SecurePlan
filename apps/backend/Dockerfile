# Stage 1: Build the NestJS application
FROM node:24-bookworm-slim AS build

WORKDIR /app

COPY package.json package-lock.json ./
COPY apps/backend/package.json ./apps/backend/package.json
COPY apps/frontend/package.json ./apps/frontend/package.json

RUN npm ci

COPY apps/backend ./apps/backend

RUN npm run build --workspace=backend

# Stage 2 — Keep production dependencies
FROM build AS production-deps

RUN npm prune --omit=dev


# Stage 3 — Production Runtime
FROM node:24-bookworm-slim AS runtime

WORKDIR /app

ENV NODE_ENV=production

COPY --from=production-deps /app/node_modules ./node_modules

COPY --from=build /app/package.json ./package.json
COPY --from=build /app/apps/backend/package.json ./apps/backend/package.json
COPY --from=build /app/apps/backend/dist ./apps/backend/dist

# Run as non-root user
USER node

EXPOSE 3000

CMD ["node", "apps/backend/dist/main.js"]