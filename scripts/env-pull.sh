#!/bin/sh
# Maintainers only: writes each app's local .env from Infisical (secrets.odev.us,
# "Tuti" project). If you don't use Infisical, copy the .env.example files instead;
# nothing else in the repo depends on this script.
#
# The files are generated, so change values in Infisical (or add a personal
# override there) and pull again. Also the way to give a fresh worktree its env.
#
# Needs the Infisical CLI and a login once per machine: `infisical login`.
# See docs/secrets.md for the folder layout.
set -e
cd "$(dirname "$0")/.."

# Passed explicitly: with a machine token the CLI ignores .infisical.json.
PROJECT=5bc28b50-3524-44d4-a145-33846604efd6
API=https://secrets.odev.us/api

# pull <env> <infisical path> <target file>
pull() {
  {
    echo "# ------------------------------------------------------------------------------"
    echo "# GENERATED FILE — overwritten by \`pnpm env:pull\` from Infisical ($1:$2)."
    echo "# Don't edit it here: change the value in Infisical (https://secrets.odev.us, or"
    echo "# a personal override there for values only you need), then run \`pnpm env:pull\`."
    echo "# ------------------------------------------------------------------------------"
    infisical export --domain="$API" --projectId="$PROJECT" \
      --env="$1" --path="$2" --format=dotenv --silent
  } > "$3.tmp"
  mv "$3.tmp" "$3"
  echo "$3  <-  $1:$2 ($(grep -c '^[A-Za-z_]' "$3") vars)"
}

pull dev /web     apps/web/.env
pull dev /worker  apps/worker/.env
pull dev /scripts packages/db/.env
