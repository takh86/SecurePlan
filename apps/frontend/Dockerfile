# ========================================
# Stage 1 — Build React / Vite
# ========================================
FROM node:24-bookworm-slim AS build

WORKDIR /app

# Root npm workspaces dependencies
COPY package.json package-lock.json ./
COPY apps/frontend/package.json ./apps/frontend/package.json
COPY apps/backend/package.json ./apps/backend/package.json

# Reproducible dependency installation
RUN npm ci

# Copy frontend source code
COPY apps/frontend/ ./apps/frontend/

# Produce optimized production assets
RUN npm run build --workspace=frontend


# ========================================
# Stage 2 — Serve with Nginx
# ========================================
FROM nginx:stable-alpine AS runtime

# Nginx configuration
COPY infra/docker/nginx.frontend.conf /etc/nginx/conf.d/default.conf

# Only copy the compiled frontend
COPY --from=build /app/apps/frontend/dist/ /usr/share/nginx/html/

EXPOSE 8443

CMD ["nginx", "-g", "daemon off;"]