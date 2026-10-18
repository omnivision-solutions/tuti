#!/usr/bin/env bash
# Posts the E2E journey screenshots of a CI run on its pull request: uploads them to
# S3-compatible storage (e.g. Cloudflare R2) and adds or updates one PR comment.
#
# Runs from .github/workflows/screenshots.yml with repository secrets, so it must
# never execute anything from the pull request: the artifact is data, and only
# files named like 01-step-name.png in a plainly named folder are used.
#
# Needs: gh, aws, jq; GH_TOKEN, AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY and
# REPO, RUN_ID, RUN_ATTEMPT, RUN_URL, HEAD_SHA, S3_ENDPOINT, S3_BUCKET, PUBLIC_BASE_URL.
set -euo pipefail

marker="<!-- tuti-e2e-screenshots -->"
# The comment to update is the one this workflow posted (override to test locally).
author="${COMMENT_AUTHOR:-github-actions[bot]}"
base_url="${PUBLIC_BASE_URL%/}"
case "$base_url" in https://*) ;; *) echo "PUBLIC_BASE_URL must use https" >&2; exit 1 ;; esac
# Uploads are signed with the storage keys: https only (plain http just for a local mock).
case "$S3_ENDPOINT" in https://* | http://127.0.0.1:* | http://localhost:*) ;; *) echo "S3_ENDPOINT must use https" >&2; exit 1 ;; esac

# The pull request this run was for, if it's still that PR's latest commit.
pr=$(gh pr list --repo "$REPO" --state open --search "$HEAD_SHA" --json number,headRefOid \
  --jq "[.[] | select(.headRefOid == \"$HEAD_SHA\")][0].number // empty")
still_latest() { [[ $(gh pr view "$pr" --repo "$REPO" --json headRefOid --jq .headRefOid) == "$HEAD_SHA" ]]; }
if [[ -z "$pr" ]]; then
  echo "No open pull request has $HEAD_SHA as its latest commit; nothing to post."
  exit 0
fi

work=$(mktemp -d)
if ! gh run download "$RUN_ID" --repo "$REPO" --name e2e-screenshots --dir "$work/artifact"; then
  echo "This run has no e2e-screenshots artifact; nothing to post."
  exit 0
fi

prefix="prs/$pr/$RUN_ID-$RUN_ATTEMPT"
body="$marker
### Screenshots

From the E2E journeys on \`${HEAD_SHA:0:7}\` ([run]($RUN_URL)). Click one for full size."
found=0

for dir in "$work/artifact"/*/; do
  journey=$(basename "$dir")
  [[ "$journey" =~ ^[a-z0-9-]{1,80}$ ]] || { echo "Skipping folder: $journey"; continue; }
  section=""
  for file in "$dir"*.png; do
    [[ -f "$file" ]] || continue
    name=$(basename "$file")
    [[ "$name" =~ ^[0-9]{2}-[a-z0-9-]{1,60}\.png$ ]] || { echo "Skipping file: $journey/$name"; continue; }
    (( $(stat -c %s "$file") <= 5000000 )) || { echo "Skipping large file: $journey/$name"; continue; }
    head -c 8 "$file" | cmp -s - <(printf '\x89PNG\r\n\x1a\n') || { echo "Skipping non-PNG: $journey/$name"; continue; }

    aws s3 cp "$file" "s3://$S3_BUCKET/$prefix/$journey/$name" --endpoint-url "$S3_ENDPOINT" \
      --content-type image/png --cache-control "public, max-age=31536000, immutable" --only-show-errors
    url="$base_url/$prefix/$journey/$name"
    section+="<a href=\"$url\"><img src=\"$url\" width=\"240\" alt=\"${name%.png}\" title=\"${name%.png}\"></a> "
    found=$((found + 1))
  done
  [[ -n "$section" ]] && body+="

<details open><summary>${journey//-/ }</summary>

$section

</details>"
done

if (( found == 0 )); then
  echo "No screenshots in the artifact; nothing to post."
  exit 0
fi

# A newer commit may have arrived while uploading; its own run will post instead.
if ! still_latest; then
  echo "#$pr has a newer commit than $HEAD_SHA now; not posting."
  exit 0
fi
comment=$(gh api --paginate "repos/$REPO/issues/$pr/comments" \
  --jq ".[] | select(.user.login == \"$author\" and (.body | contains(\"$marker\"))) | .id" | tail -n 1)
payload=$(jq -n --arg body "$body" '{body: $body}')
if [[ -n "$comment" ]]; then
  gh api --method PATCH "repos/$REPO/issues/comments/$comment" --input - <<<"$payload" >/dev/null
else
  gh api --method POST "repos/$REPO/issues/$pr/comments" --input - <<<"$payload" >/dev/null
fi
echo "Posted $found screenshots on #$pr."
