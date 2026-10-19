#!/bin/sh
# Container start: apply database migrations, then serve the web app.
#
# With INFISICAL_TOKEN set (the maintainers' deployment), settings come from
# Infisical's /web folder (docs/secrets.md; INFISICAL_DOMAIN and
# INFISICAL_PROJECT_ID say where). Without it, from plain environment variables,
# so the image works for anyone self-hosting.
set -e

with_settings() {
  if [ -n "$INFISICAL_TOKEN" ]; then
    exec infisical run --domain="$INFISICAL_DOMAIN" --projectId="$INFISICAL_PROJECT_ID" \
      --env="${INFISICAL_ENV:-prod}" --path=/web --silent -- "$@"
  fi
  exec "$@"
}

web="$(cd "$(dirname "$0")" && pwd)"
(cd "$web/../../packages/db" && with_settings node_modules/.bin/prisma migrate deploy)
cd "$web"
with_settings node_modules/.bin/next start
