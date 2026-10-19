# Tuti worker: background jobs on Hatchet (duplicate detection). Build from the
# repo root:
#   docker build -f apps/worker/Dockerfile -t tuti-worker .
# Not needed with JOBS_DRIVER=inline (jobs then run inside the web app).
FROM mirror.gcr.io/library/node:22-alpine AS base
RUN apk add --no-cache libc6-compat openssl
RUN corepack enable

# Only the worker and the workspace packages it uses (no Next.js, no web app).
FROM base AS pruner
WORKDIR /app
COPY . .
RUN pnpm dlx turbo@2.11.6 prune @tuti/worker --docker

FROM base AS builder
WORKDIR /app
COPY --from=pruner /app/out/json/ .
RUN --mount=type=cache,id=tuti-pnpm-store,target=/pnpm-store \
    pnpm install --frozen-lockfile --store-dir=/pnpm-store
COPY --from=pruner /app/out/full/ .
RUN pnpm turbo run build --filter=@tuti/worker
# The bundle (dist/, workspace code inlined by tsup) and its production
# dependencies only. Peers aren't auto-installed: @prisma/client would pull in the
# whole Prisma CLI, which the worker never runs.
RUN --mount=type=cache,id=tuti-pnpm-store,target=/pnpm-store \
    pnpm --filter=@tuti/worker deploy --prod --legacy --config.auto-install-peers=false \
      --store-dir=/pnpm-store /prod/worker \
    && chmod +x /prod/worker/start.sh

FROM base AS runner
ARG INFISICAL_CLI_VERSION=0.43.137
RUN apk add --no-cache bash wget \
    && wget -qO- 'https://artifacts-cli.infisical.com/setup.apk.sh' | sh \
    && apk add --no-cache infisical=${INFISICAL_CLI_VERSION}
WORKDIR /app
ENV NODE_ENV=production
RUN addgroup --system --gid 1001 nodejs && adduser --system --uid 1001 worker
COPY --from=builder --chown=worker:nodejs /prod/worker ./
USER worker
# No HTTP port: it connects out to Hatchet.
CMD ["/app/start.sh"]
