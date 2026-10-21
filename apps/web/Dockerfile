# Tuti web app: dashboard, portals, auth and API. Build from the repo root:
#   docker build -f apps/web/Dockerfile -t tuti-web .
# Configure it with environment variables (see apps/web/.env.example); the
# container applies database migrations, then serves on $PORT (3000).
FROM mirror.gcr.io/library/node:22-alpine AS base
RUN apk add --no-cache libc6-compat openssl
# pnpm, the version in package.json's packageManager
RUN corepack enable

# Only the web app and the workspace packages it uses, with a lockfile to match.
FROM base AS pruner
WORKDIR /app
COPY . .
RUN pnpm dlx turbo@2.11.6 prune @tuti/web --docker

FROM base AS builder
WORKDIR /app
# Dependencies first: they change less often than the code.
COPY --from=pruner /app/out/json/ .
RUN --mount=type=cache,id=tuti-pnpm-store,target=/pnpm-store \
    pnpm install --frozen-lockfile --store-dir=/pnpm-store
COPY --from=pruner /app/out/full/ .
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
# Optional: the origin pages load Next.js's files from (e.g. https://tuti.so), for portals under a
# path of a team's own site; it's fixed when building (see next.config.ts).
ARG ASSET_PREFIX=""
ENV ASSET_PREFIX=$ASSET_PREFIX
# The build needs no secrets. These placeholders (for this command only) satisfy
# modules that read their settings on import; real values come at run time.
RUN --mount=type=cache,id=tuti-next-cache,target=/app/apps/web/.next/cache \
    APP_URL=https://tuti.example PORTAL_URL_TEMPLATE='https://{project}.tuti.example' \
    BETTER_AUTH_SECRET=build-time-placeholder-not-used-at-run-time \
    pnpm turbo run build --filter=@tuti/web

FROM base AS runner
# Infisical CLI, used only when INFISICAL_TOKEN is set (the maintainers' deployment,
# docs/secrets.md). Pinned so an upgrade is a deliberate change.
ARG INFISICAL_CLI_VERSION=0.43.137
RUN apk add --no-cache bash wget \
    && wget -qO- 'https://artifacts-cli.infisical.com/setup.apk.sh' | sh \
    && apk add --no-cache infisical=${INFISICAL_CLI_VERSION}
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
# Don't run production as root
RUN addgroup --system --gid 1001 nodejs && adduser --system --uid 1001 tuti
# The pruned workspace: pnpm's node_modules link across packages, and the Prisma
# CLI (for migrations at start) lives in packages/db.
# ponytail: ships dev dependencies too; Next's standalone output plus the Prisma CLI
# alone would shrink the image, when its size starts to matter.
COPY --from=builder --chown=tuti:nodejs /app ./
USER tuti
ENV HOSTNAME=0.0.0.0
ENV PORT=3000
EXPOSE 3000
CMD ["/app/apps/web/start.sh"]
