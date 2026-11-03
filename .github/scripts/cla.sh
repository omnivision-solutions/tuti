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
# The whole comment is the sentence (any case, a full stop allowed): a quote reply that adds
# "but first…" isn't agreeing.
signed_in() {
  jq -e --arg who "$1" --arg phrase "$PHRASE" \
    'add // [] | any(.user.login == $who and ((.body | ascii_downcase | gsub("^\\s+|[.!]?\\s*$"; "")) == ($phrase | ascii_downcase)))' > /dev/null
}

# Prints why <login> needs no signature or has signed (0), or why not (1). 2: GitHub didn't
# answer, so nothing is known: the job fails rather than call anyone unsigned.
verdict() {
  local login=$1 type=$2 permission found number here
  # As review-risk.yml checks it: admin, write, read or none; a 404 for an unknown account.
  if ! permission=$(gh api "repos/$REPO/collaborators/$login/permission" --jq .permission 2> "$RUNNER_TEMP/error"); then
    grep -q 'HTTP 404' "$RUNNER_TEMP/error" || { cat "$RUNNER_TEMP/error" >&2; return 2; }
    permission=none
  fi
  if [[ "$type" == Bot || "$permission" == admin || "$permission" == write ]]; then
    echo "Not needed: $login can write to the repository"
    return 0
  fi
  # The commented pull request first: the search can lag a minute behind a new comment.
  here=$(comments "$PR") || return 2
  if signed_in "$login" <<< "$here"; then
    echo "Signed by $login"
    return 0
  fi
  found=$(gh api -X GET search/issues -f q="repo:$REPO is:pr commenter:$login \"$PHRASE\"" --jq '.items[].number') || return 2
  for number in $found; do
    [[ "$number" != "$PR" ]] || continue
    here=$(comments "$number") || return 2
    if signed_in "$login" <<< "$here"; then
      echo "Signed by $login on #$number"
      return 0
    fi
  done
  echo "Not signed by $login: comment \"$PHRASE\" to sign"
  return 1
}

numbers=$PR
if [[ "$EVENT" == issue_comment ]]; then
  numbers=$(gh api -X GET search/issues -f q="repo:$REPO is:pr is:open author:$AUTHOR" --jq '.items[].number')
  numbers=$(printf '%s\n' "$PR" $numbers | sort -un)
fi
for number in $numbers; do
  pull=$(gh api "repos/$REPO/pulls/$number")
  head=$(jq -r .head.sha <<< "$pull")
  author=$(jq -r .user.login <<< "$pull")
  # The status belongs to the commit, so it passes only if every open pull request headed there
  # would: one opened at a team member's commit can't pass for an author who hasn't signed.
  others=$(gh api "repos/$REPO/commits/$head/pulls" | jq -r --arg head "$head" \
    '.[] | select(.state == "open" and .head.sha == $head) | "\(.user.login) \(.user.type)"')
  state=success description="" unsigned=""
  while read -r login type; do
    if why=$(verdict "$login" "$type"); then
      description=${description:-$why}
    elif [[ $? == 1 ]]; then
      state=failure description=$why unsigned=$login
      break
    else
      exit 1
    fi
  done < <(printf '%s\n' "$(jq -r '"\(.user.login) \(.user.type)"' <<< "$pull")" "$others" | grep . | sort -u)
  # A status's description holds 140 characters.
  gh api "repos/$REPO/statuses/$head" -f state="$state" -f context=CLA -f description="${description:0:140}" -f target_url="$url" --silent
  echo "#$number: $state, $description" >> "${GITHUB_STEP_SUMMARY:-/dev/null}"
  # Asked on the unsigned author's own pull request only: their comment there is what reruns this.
  [[ "$unsigned" == "$author" ]] || continue
  here=$(comments "$number")
  if ! jq -e --arg marker "$MARKER" 'add // [] | any(.body | contains($marker))' <<< "$here" > /dev/null; then
    gh api "repos/$REPO/issues/$number/comments" --silent -f body="$MARKER
Thanks for the pull request! Before it can be merged, please read our [Contributor Licence Agreement]($url). You keep the copyright to your work; it lets Tuti also be offered under other licences, alongside the AGPL.

To sign, comment on this pull request with just this sentence:

> $PHRASE

You only sign once."
  fi
done
