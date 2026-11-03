#!/usr/bin/env bash
# Whether pull requests' authors signed CLA.md (.github/workflows/cla.yml). Posts the "CLA"
# status on each pull request's head commit and, the first time it fails, asks in a comment.
# Anyone with write access, and bots, don't sign. A signature is the author's comment
# "I have read the CLA and agree to it" on any of this repository's pull requests.
#
#   REPO, PR, AUTHOR, EVENT and GH_TOKEN in the environment. On a signature (EVENT=issue_comment)
#   all of the author's open pull requests are checked again, not only PR.
set -euo pipefail

PHRASE="I have read the CLA and agree to it"
MARKER="<!-- tuti-cla -->"
url="https://github.com/$REPO/blob/main/CLA.md"

comments() { gh api --paginate --slurp "repos/$REPO/issues/$1/comments?per_page=100"; }
signed_in() {
  jq -e --arg who "$1" --arg phrase "$PHRASE" \
    'add // [] | any(.user.login == $who and (.body | ascii_downcase | contains($phrase | ascii_downcase)))' > /dev/null
}

# Prints why <login> needs no signature or has signed and succeeds, or prints why not and fails.
verdict() {
  local login=$1 type=$2 permission number
  # As review-risk.yml checks it: admin, write, read or none; a 404 for an unknown account.
  if ! permission=$(gh api "repos/$REPO/collaborators/$login/permission" --jq .permission 2> "$RUNNER_TEMP/error"); then
    grep -q 'HTTP 404' "$RUNNER_TEMP/error" || { cat "$RUNNER_TEMP/error" >&2; exit 1; }
    permission=none
  fi
  if [[ "$type" == Bot || "$permission" == admin || "$permission" == write ]]; then
    echo "Not needed: $login can write to the repository"
    return 0
  fi
  # The commented pull request first: the search can lag a minute behind a new comment.
  if comments "$PR" | signed_in "$login"; then
    echo "Signed by $login"
    return 0
  fi
  for number in $(gh api -X GET search/issues -f q="repo:$REPO is:pr commenter:$login \"$PHRASE\"" --jq '.items[].number'); do
    if [[ "$number" != "$PR" ]] && comments "$number" | signed_in "$login"; then
      echo "Signed by $login on #$number"
      return 0
    fi
  done
  echo "Not signed by $login: comment \"$PHRASE\" to sign"
  return 1
}

numbers=$PR
if [[ "$EVENT" == issue_comment ]]; then
  numbers=$( (echo "$PR"; gh api -X GET search/issues -f q="repo:$REPO is:pr is:open author:$AUTHOR" --jq '.items[].number') | sort -un)
fi
for number in $numbers; do
  pull=$(gh api "repos/$REPO/pulls/$number")
  head=$(jq -r .head.sha <<< "$pull")
  # The status belongs to the commit, so it passes only if every open pull request at it would:
  # one opened at a signed or team member's commit can't pass for an author who hasn't signed.
  state=success description=""
  while read -r login type; do
    if why=$(verdict "$login" "$type"); then
      description=${description:-$why}
    else
      state=failure description=$why
      break
    fi
  done < <( (jq -r '"\(.user.login) \(.user.type)"' <<< "$pull"
    gh api "repos/$REPO/commits/$head/pulls" --jq '.[] | select(.state == "open") | "\(.user.login) \(.user.type)"') | sort -u)
  # A status's description holds 140 characters.
  gh api "repos/$REPO/statuses/$head" -f state="$state" -f context=CLA -f description="${description:0:140}" -f target_url="$url" --silent
  echo "#$number: $state, $description" >> "${GITHUB_STEP_SUMMARY:-/dev/null}"
  if [[ "$state" == failure ]] && ! comments "$number" | jq -e --arg marker "$MARKER" 'add // [] | any(.body | contains($marker))' > /dev/null; then
    gh api "repos/$REPO/issues/$number/comments" --silent -f body="$MARKER
Thanks for the pull request! Before it can be merged, please read our [Contributor Licence Agreement]($url). You keep the copyright to your work; it lets Tuti also be offered under other licences, alongside the AGPL.

To sign, comment on this pull request:

> $PHRASE

You only sign once."
  fi
done
