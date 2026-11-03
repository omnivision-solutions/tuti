#!/usr/bin/env bash
# Whether pull requests' authors signed CLA.md (.github/workflows/cla.yml). Posts the "CLA"
# status on each pull request's head commit and, the first time it fails, asks in a comment.
# Anyone with write access, and bots, don't sign. A signature is the author's comment
# "I have read the CLA and agree to it" on any of their pull requests here (only the author's
# comment reruns the check, so that's where they sign).
#
#   REPO, PR, AUTHOR and GH_TOKEN in the environment. Checks PR and all of AUTHOR's other open
#   pull requests: a signature, or a deleted one, changes them all.
set -euo pipefail

PHRASE="I have read the CLA and agree to it"
MARKER="<!-- tuti-cla -->"
url="https://github.com/$REPO/blob/main/CLA.md"

comments() { gh api --paginate --slurp "repos/$REPO/issues/$1/comments?per_page=100"; }
# <login>'s pull requests in <state> (open or all), newest first. Read from the list rather than
# the search, which lags behind and stops at 30.
# ponytail: reads every pull request's page, a few calls per hundred; a signatures file if that gets slow.
pulls_by() { gh api --paginate "repos/$REPO/pulls?state=$2&per_page=100" | jq -r --arg who "$1" '.[] | select(.user.login == $who) | .number'; }
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
  if [[ "$login" == :unlinked ]]; then
    echo "A commit's author ($type) has no GitHub account: commit with an email on your account"
    return 1
  fi
  # As review-risk.yml checks it: admin, write, read or none; a 404 for an unknown account.
  if ! permission=$(gh api "repos/$REPO/collaborators/$login/permission" --jq .permission 2> "$RUNNER_TEMP/error"); then
    grep -q 'HTTP 404' "$RUNNER_TEMP/error" || { cat "$RUNNER_TEMP/error" >&2; return 2; }
    permission=none
  fi
  if [[ "$type" == Bot || "$permission" == admin || "$permission" == write ]]; then
    echo "Not needed: $login can write to the repository"
    return 0
  fi
  found=$(pulls_by "$login" all) || return 2
  for number in $found; do
    here=$(comments "$number") || return 2
    if signed_in "$login" <<< "$here"; then
      echo "Signed by $login on #$number"
      return 0
    fi
  done
  echo "Not signed by $login: comment \"$PHRASE\" to sign"
  return 1
}

# Each login's verdict once per run: it reads every pull request's page.
declare -A verdicts reasons
numbers=$(pulls_by "$AUTHOR" open)
numbers=$(printf '%s\n' "$PR" $numbers | sort -un)
for number in $numbers; do
  pull=$(gh api "repos/$REPO/pulls/$number")
  head=$(jq -r .head.sha <<< "$pull")
  author=$(jq -r .user.login <<< "$pull")
  # The status belongs to the commit, so it passes only if every open pull request headed there
  # would: one opened at a team member's commit can't pass for an author who hasn't signed.
  others=$(gh api --paginate "repos/$REPO/commits/$head/pulls?per_page=100" | jq -r --arg head "$head" \
    '.[] | select(.state == "open" and .head.sha == $head) | "\(.user.login) \(.user.type)"')
  # Whoever wrote the code, too: a team member's pull request can carry an outsider's commits.
  # ponytail: authors only, not Co-authored-by trailers; GitHub lists up to 250 commits.
  authors=$(gh api --paginate "repos/$REPO/pulls/$number/commits?per_page=100" \
    | jq -r '.[] | if .author then "\(.author.login) \(.author.type)" else ":unlinked \(.commit.author.name)" end')
  state=success description="" unsigned=""
  while read -r login type; do
    if [[ -z "${verdicts[$login]:-}" ]]; then
      if reasons[$login]=$(verdict "$login" "$type"); then verdicts[$login]=0; else verdicts[$login]=$?; fi
    fi
    why=${reasons[$login]}
    case "${verdicts[$login]}" in
      0) description=${description:-$why} ;;
      1) state=failure description=$why unsigned=$login; break ;;
      *) exit 1 ;;
    esac
  done < <(printf '%s\n' "$(jq -r '"\(.user.login) \(.user.type)"' <<< "$pull")" "$others" "$authors" | grep . | awk '!seen[$0]++')
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
