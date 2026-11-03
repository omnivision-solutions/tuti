#!/usr/bin/env bash
# Whether every open pull request's authors, and its commits' authors, signed CLA.md
# (.github/workflows/cla.yml). Posts the "CLA" status on each one's head commit and, the first
# time its own author hasn't signed, asks in a comment. Anyone with write access, and bots,
# don't sign. A signature is the person's comment "I have read the CLA and agree to it" on any
# pull request they opened here, closed ones too (only the author's comment reruns the check).
# Every run checks every open pull request: a signature, or a deleted one, can change any of them.
# ponytail: a few calls per open pull request; check only those a person touches if that's slow.
#
#   REPO and GH_TOKEN in the environment.
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
  echo "Not signed by $login: comment \"$PHRASE\" on a pull request you opened"
  return 1
}

# Each login's verdict once per run: it reads every pull request's page.
declare -A verdicts reasons
# A status belongs to a commit, so it passes only if every open pull request headed there would.
# A commit whose check GitHub didn't answer gets no status (an old one stays; a new head stays
# blocked), the rest still do, and the job fails at the end.
declare -A states descriptions unknown
broken=0
heads=$(gh api --paginate "repos/$REPO/pulls?state=open&per_page=100" | jq -r '.[] | "\(.number) \(.head.sha)"')
# On fd 3, so nothing in the loop reads the list as its input.
while read -r number head <&3; do
  [[ -n "$number" ]] || continue
  # Whoever wrote the code, too: a team member's pull request can carry an outsider's commits.
  # ponytail: authors only, not Co-authored-by trailers.
  if ! pull=$(gh api "repos/$REPO/pulls/$number") || ! authors=$(gh api --paginate "repos/$REPO/pulls/$number/commits?per_page=100" \
    | jq -r '.[] | if .author then "\(.author.login) \(.author.type)" else ":unlinked \(.commit.author.name)" end'); then
    broken=1 unknown[$head]=1
    continue
  fi
  author=$(jq -r .user.login <<< "$pull")
  state=success description="" unsigned=""
  # GitHub lists a pull request's first 250 commits only: past that, the rest can't be checked.
  if (( $(jq ".commits // 0" <<< "$pull") > 250 )); then
    state=failure description="Over 250 commits, more than GitHub lists: split it so every author can be checked"
    authors=""
  fi
  while [[ "$state" == success ]] && read -r login type; do
    # By name as well: every commit with no account has the same login.
    key="$login $type"
    if [[ -z "${verdicts[$key]:-}" ]]; then
      if reasons[$key]=$(verdict "$login" "$type"); then verdicts[$key]=0; else verdicts[$key]=$?; fi
    fi
    why=${reasons[$key]}
    case "${verdicts[$key]}" in
      0) description=${description:-$why} ;;
      1) state=failure description=$why unsigned=$login ;;
      *) state=unknown ;;
    esac
  done < <(printf '%s\n' "$(jq -r '"\(.user.login) \(.user.type)"' <<< "$pull")" "$authors" | grep . | awk '!seen[$0]++')
  if [[ "$state" == unknown ]]; then
    broken=1 unknown[$head]=1
    continue
  fi
  echo "#$number: $state, $description" >> "${GITHUB_STEP_SUMMARY:-/dev/null}"
  if [[ "${states[$head]:-success}" == success ]]; then
    states[$head]=$state descriptions[$head]=$description
  fi
  # Asked on the unsigned author's own pull request only: their comment there is what reruns this.
  [[ "$unsigned" == "$author" ]] || continue
  here=$(comments "$number") || { broken=1; continue; }
  if ! jq -e --arg marker "$MARKER" 'add // [] | any(.body | contains($marker))' <<< "$here" > /dev/null; then
    gh api "repos/$REPO/issues/$number/comments" --silent -f body="$MARKER
Thanks for the pull request! Before it can be merged, please read our [Contributor Licence Agreement]($url). You keep the copyright to your work; it lets Tuti also be offered under other licences, alongside the AGPL.

To sign, comment on this pull request with just this sentence:

> $PHRASE

You only sign once." || broken=1
  fi
done 3<<< "$heads"
for head in "${!states[@]}"; do
  [[ -z "${unknown[$head]:-}" ]] || continue
  # A status's description holds 140 characters.
  gh api "repos/$REPO/statuses/$head" -f state="${states[$head]}" -f context=CLA \
    -f description="${descriptions[$head]:0:140}" -f target_url="$url" --silent || broken=1
done
exit "$broken"
