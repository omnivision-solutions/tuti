#!/usr/bin/env bash
# Applies the weekly dependency update's patch (.github/workflows/weekly-dependencies.yml),
# refusing any change to workflows, agent or review-bot instructions, or env files.
set -euo pipefail

patch=$1
# Look at the patch in a temporary index before touching the checkout.
export GIT_INDEX_FILE="$RUNNER_TEMP/dependency-update.index"
git read-tree HEAD
git apply --cached "$patch"
git diff --cached --name-only --no-renames -z > "$RUNNER_TEMP/dependency-update.paths"
while IFS= read -r -d '' file; do
  case "$file" in
    .github|.github/*|.claude|.claude/*|.agents|.agents/*|AGENTS.md|*/AGENTS.md|CLAUDE.md|*/CLAUDE.md|\
    SKILL.md|*/SKILL.md|.coderabbit.yaml|greptile.json|.env*|*/.env*)
      echo "::error::The dependency patch changes $(printf %q "$file"): workflows, instructions and env files are off limits."
      exit 1 ;;
  esac
done < "$RUNNER_TEMP/dependency-update.paths"
unset GIT_INDEX_FILE
git apply --index "$patch"
