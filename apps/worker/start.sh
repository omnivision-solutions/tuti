#!/bin/sh
# Container start for the worker. The web container runs the database migrations.
#
# With INFISICAL_TOKEN set (the maintainers' deployment), settings come from
# Infisical's /worker folder (docs/secrets.md). Without it, from plain
# environment variables.
set -e

if [ -n "$INFISICAL_TOKEN" ] && { [ -z "$INFISICAL_DOMAIN" ] || [ -z "$INFISICAL_PROJECT_ID" ]; }; then
  echo "INFISICAL_TOKEN is set, so INFISICAL_DOMAIN and INFISICAL_PROJECT_ID are needed too" >&2
  exit 1
fi

cd "$(dirname "$0")"
if [ -n "$INFISICAL_TOKEN" ]; then
  exec infisical run --domain="$INFISICAL_DOMAIN" --projectId="$INFISICAL_PROJECT_ID" \
    --env="${INFISICAL_ENV:-prod}" --path=/worker --silent -- node dist/index.js
fi
exec node dist/index.js
