#!/usr/bin/env bash
# Whether a pull request's author signed CLA.md (.github/workflows/cla.yml). Posts the "CLA"
# status on the pull request's head commit and, the first time it fails, asks in a comment.
# Anyone with write access, and bots, don't sign. A signature is the author's comment
# "I have read the CLA and agree to it" on any of this repository's pull requests.
#
#   REPO, PR, AUTHOR, AUTHOR_TYPE and GH_TOKEN in the environment.
set -euo pipefail

PHRASE="I have read the CLA and agree to it"
MARKER="<!-- tuti-cla -->"
url="https://github.com/$REPO/blob/main/CLA.md"
head=$(gh api "repos/$REPO/pulls/$PR" --jq .head.sha)
status() { gh api "repos/$REPO/statuses/$head" -f state="$1" -f context=CLA -f description="$2" -f target_url="$url" --silent; }

# As review-risk.yml checks it: admin, write, read or none; a 404 for an unknown account.
if ! permission=$(gh api "repos/$REPO/collaborators/$AUTHOR/permission" --jq .permission 2> "$RUNNER_TEMP/error"); then
  grep -q 'HTTP 404' "$RUNNER_TEMP/error" || { cat "$RUNNER_TEMP/error" >&2; exit 1; }
  permission=none
fi
if [[ "$AUTHOR_TYPE" == Bot || "$permission" == admin || "$permission" == write ]]; then
  status success "Not needed: $AUTHOR can write to the repository"
  exit 0
fi

comments() { gh api --paginate --slurp "repos/$REPO/issues/$1/comments?per_page=100"; }
signed() {
  jq -e --arg who "$AUTHOR" --arg phrase "$PHRASE" \
    'add // [] | any(.user.login == $who and (.body | ascii_downcase | contains($phrase | ascii_downcase)))' > /dev/null
}
# This pull request first: the search can lag a minute behind a new comment.
here=$(comments "$PR")
if signed <<< "$here"; then
  status success "Signed by $AUTHOR"
  exit 0
fi
for number in $(gh api -X GET search/issues -f q="repo:$REPO is:pr commenter:$AUTHOR \"$PHRASE\"" --jq '.items[].number'); do
  if [[ "$number" != "$PR" ]] && comments "$number" | signed; then
    status success "Signed by $AUTHOR on #$number"
    exit 0
  fi
done

status failure "Not signed: comment \"$PHRASE\" to sign"
if ! jq -e --arg marker "$MARKER" 'add // [] | any(.body | contains($marker))' <<< "$here" > /dev/null; then
  gh api "repos/$REPO/issues/$PR/comments" --silent -f body="$MARKER
Thanks for the pull request! Before it can be merged, please read our [Contributor Licence Agreement]($url). You keep the copyright to your work; it lets Tuti also be offered under other licences, alongside the AGPL.

To sign, comment on this pull request:

> $PHRASE

You only sign once."
fi
