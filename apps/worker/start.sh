#!/bin/sh
# Container start for the worker. The web container runs the database migrations.
#
# With INFISICAL_TOKEN set (the maintainers' deployment), settings come from
# Infisical's /worker folder (docs/secrets.md). Without it, from plain
# environment variables.
set -e

cd "$(dirname "$0")"
if [ -n "$INFISICAL_TOKEN" ]; then
  exec infisical run --domain="$INFISICAL_DOMAIN" --projectId="$INFISICAL_PROJECT_ID" \
    --env="${INFISICAL_ENV:-prod}" --path=/worker --silent -- node dist/index.js
fi
exec node dist/index.js
