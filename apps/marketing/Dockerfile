# Tuti's marketing site (tuti.so's home, pricing and legal pages). Build from the repo root:
#   docker build -f apps/marketing/Dockerfile -t tuti-marketing .
# It needs one setting at run time, APP_URL: the app's public address, for its plans (README, "Production routing").
# Serves on $PORT (3000).
FROM mirror.gcr.io/library/node:22-alpine AS base
RUN apk add --no-cache libc6-compat && apk upgrade --no-cache zlib
# pnpm, the version in package.json's packageManager
RUN corepack enable

# Only the site and the workspace packages it uses, with a lockfile to match.
FROM base AS pruner
WORKDIR /app
COPY . .
RUN pnpm dlx turbo@2.11.6 prune @tuti/marketing --docker

FROM base AS builder
WORKDIR /app
COPY --from=pruner /app/out/json/ .
RUN --mount=type=cache,id=tuti-pnpm-store,target=/pnpm-store \
    pnpm install --frozen-lockfile --store-dir=/pnpm-store
COPY --from=pruner /app/out/full/ .
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
RUN --mount=type=cache,id=tuti-marketing-next-cache,target=/app/apps/marketing/.next/cache \
    pnpm turbo run build --filter=@tuti/marketing

FROM base AS runner
# npm comes with the Node image but nothing here runs it, and its bundled packages carry known vulnerabilities.
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
# Don't run production as root
RUN addgroup --system --gid 1001 nodejs && adduser --system --uid 1001 tuti
# ponytail: the pruned workspace with dev dependencies, as the web image; Next's standalone output when size matters.
COPY --from=builder --chown=tuti:nodejs /app ./
USER tuti
WORKDIR /app/apps/marketing
ENV HOSTNAME=0.0.0.0
ENV PORT=3000
EXPOSE 3000
CMD ["node_modules/.bin/next", "start"]
