# Built only in CI — nothing in local development needs Docker
# (docs/architecture.md §7.1). Targets linux/amd64 for Cloud Run regardless of
# the machine that triggered the build.

# Debian slim rather than Alpine, deliberately. Prisma and sharp both ship
# glibc-first native binaries; the musl variants are an ongoing source of
# "works locally, fails in the container" bugs, and this project cannot debug
# a container locally at all.
FROM node:22-slim AS base


# --- dependencies -----------------------------------------------------------
# Isolated so a source-only change reuses the cached npm layer.
FROM base AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci


# --- build ------------------------------------------------------------------
FROM base AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .

# Baked into the image so the status page can report which commit is serving.
ARG GIT_SHA=unknown
ENV GIT_SHA=$GIT_SHA

ENV NEXT_TELEMETRY_DISABLED=1

# The client is generated into node_modules and is imported by the app, so it
# must exist before the build. It cannot be generated in the deps stage: only
# package.json is present there, not prisma/schema.prisma.
RUN npx prisma generate

RUN npm run build


# --- runtime ----------------------------------------------------------------
FROM base AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1

# Cloud Run injects PORT and routes to it. HOSTNAME must be 0.0.0.0: the Next
# standalone server otherwise binds localhost, the container never answers the
# health check, and the revision fails to start with no useful error.
ENV PORT=8080
ENV HOSTNAME=0.0.0.0

RUN groupadd --system --gid 1001 nodejs \
  && useradd --system --uid 1001 --gid nodejs nextjs

# `output: standalone` emits server.js and a pruned node_modules, but NOT the
# static assets. Without the second COPY the app boots and serves completely
# unstyled HTML — verified, and the failure is silent.
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static

ARG GIT_SHA=unknown
ENV GIT_SHA=$GIT_SHA

USER nextjs
EXPOSE 8080

CMD ["node", "server.js"]
