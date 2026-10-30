---
name: pr-watch
description: Stay with a pull request after opening or updating it until CI and review bots have finished on its latest commit and every finding is answered, then merge. Use after creating a PR, after pushing to one, or when asked to watch, babysit or land a PR.
---

# Watch a pull request until it can land

Passing checks alone don't mean a PR is done: review bots post after CI starts, and every finding needs an answer.

Each PR gets one review bot, so their rate limits last (`.github/workflows/review-bot.yml`): **CodeRabbit** (`.coderabbit.yaml`) on PRs labeled `review:coderabbit`, **Greptile** (`greptile.json`) on PRs labeled `review:greptile`; neither reviews an unlabeled PR. The workflow labels odd-numbered PRs for CodeRabbit and even ones for Greptile when they open (plus an `@greptileai` comment, since Greptile doesn't start on a label alone), and swaps the label (plus `@coderabbitai review`) when Greptile says it can no longer review or has run out of credits. Swap the label by hand to switch one PR: `gh pr edit <n> --remove-label review:greptile --add-label review:coderabbit` then comment `@coderabbitai review`, or the reverse (`--remove-label review:coderabbit --add-label review:greptile`) then `@greptileai`. On a fork PR the workflow can't add the label after Greptile's "Reactivate Greptile" review (its token is read-only there), so add it yourself, or as the contributor ask a maintainer to. The PR's bot reviews every push, often 10–15 minutes each, and shows up as its status on the commit (`Greptile Review` or `CodeRabbit`). Greptile's "Reactivate Greptile" and "run out of review credits" notices are not findings. Out of credits, Greptile may also post nothing at all: when it has no status, review or comment on the head 20 minutes after the push or the latest `@greptileai`, or it has said it's out of credits and the label is still `review:greptile`, the digest's `BOT` line says so with the swap commands. Swap right away; don't wait for Greptile. Claude Code also reviews every push to a PR from this repository while we compare it with the bots (`.github/workflows/claude-review.yml`): its `Claude review` check is pending until it's done, and its findings are inline comments from `github-actions[bot]`, answered like any bot's. `main` only merges when every review thread is resolved. Each push costs a review, so before opening or pushing: review your own diff for races, partial failures, retries and stale reads, run the full suites, and push fixes together rather than one at a time.

Before opening the PR, run the Claude review on your commits yourself: the same prompt and model CI uses. It takes a minute for a small change and several for a large one, and prints nothing until it's done: give the Bash tool its longest timeout (10 minutes) or run it in the background. Fix what holds up and commit before pushing; every finding caught here is a review round saved. It loads none of your settings, plugins, MCP servers, skills or memory, and can only read, close to CI's fresh reviewer. It reads your working tree, so it refuses to run until everything is committed. Set `BASE` to the lower branch when stacking.

```sh
if ! root=$(git rev-parse --show-toplevel) || ! cd "$root" || [ ! -f .github/prompts/claude-review.md ]; then
  echo "Run it inside a Tuti checkout: nothing reviewed." >&2
elif [ -n "$(git status --porcelain)" ]; then
  echo "Commit first: the review reads the working tree." >&2
elif ! git fetch -q origin || ! base=$(git merge-base "${BASE:-origin/main}" HEAD); then
  echo "Couldn't fetch or find the base: nothing reviewed." >&2
else
  { cat .github/prompts/claude-review.md
    printf '\n## This pull request\n\nBase %s, head %s. No title or description yet: judge the change by its commits.\n\n## Your earlier findings and the replies to them\n\nNone.\n' \
      "$base" "$(git rev-parse HEAD)"
  } | claude -p --model claude-opus-5-5 --setting-sources "" --settings '{"autoMemoryEnabled": false}' \
      --permission-mode default --strict-mcp-config --disable-slash-commands --no-session-persistence
fi
```

## Read the PR with the digest

`node .claude/skills/pr-watch/pr-digest.mjs [<n>]` (from the repo root) reads the PR's head commit once: its check runs and commit statuses, the review bot its label asks for, review threads, comments and reviews. It prints only what needs a decision, then a `VERDICT`:

| Verdict | Exit | Means |
| --- | --- | --- |
| `green` | 0 | The gate below holds, except what only you can judge (last section of it). |
| `failures` | 10 | A check or status failed on the head (`FAIL` lines). |
| `no-bot` | 13 | No `review:*` label, or Greptile is out of credits or silent: no bot reviews this PR. Add or swap the label as the `BOT` line says. |
| `open-comments` | 11 | Comments to answer, threads to resolve or a change request (`[…]` blocks). |
| `pending` | 12 | Checks or the PR's bot haven't finished on the head (`PENDING`, `BOT` lines). |
| `out-of-sync` | 20 | Your local branch, the PR head and the remote disagree, the head moved while reading, or the PR conflicts with `main`. Sync or rebase first. |

Use it instead of reading checks and comments with `gh api` by hand. A verdict is good only for the head it names.

## Wait without polling

- In T3 Code, call `watch_pull_request` with the PR URL and end your turn. You're woken when checks finish, someone comments or reviews, or the branch conflicts; run the digest on each wake.
- Elsewhere, run `node .claude/skills/pr-watch/pr-digest.mjs --watch <n>` as one background command. It waits until nothing is pending or a new failure or comment arrives, then prints the digest. Never sleep-and-poll in the foreground.

## On each wake

1. **Failed checks.** Read the log before guessing: `gh run view <run-id> --log-failed` (the run id is in the `FAIL` line's URL). Fix the cause and push. Before calling a failure unrelated or flaky, restore the touched files to `main`, rerun that test, and say what happened in the PR.
2. **Review comments.** Each `[…]` block is a comment with no reply from you after its latest edit, an unresolved thread, or a change request. Judge each on its merits; bots are confidently wrong often enough to check.
   - Real issue: fix it, push, then reply in the thread saying what changed.
   - Wrong: reply with the evidence (code, test, docs).
   - A product decision: ask the user.
   Reply to an inline comment in its thread: `gh api repos/{owner}/{repo}/pulls/<n>/comments/<id>/replies -f body='…'`. A conversation comment or a review's own text (a person's review, or CodeRabbit's comments outside the diff and nitpicks) has no thread: answer with a new `gh pr comment` that quotes its full permalink (the digest prints it). A person's follow-up in a thread, or their edit after your reply, needs another reply; a bot's follow-ups and edits to its own comments don't.
   - Resolving: once a bot's finding is fixed or answered, resolve that thread (CodeRabbit often resolves its own after the fix lands). Resolve one thread at a time with the id the digest prints: `gh api graphql -f query='mutation($id:ID!){resolveReviewThread(input:{threadId:$id}){thread{isResolved}}}' -f id=<thread-id>`. `@coderabbitai resolve` resolves *all* of CodeRabbit's threads, so use it only once every one of them is handled. A person's thread is theirs to resolve: reply, and ask the user if it blocks the merge.
3. Repeat after every push. Each push restarts the wait: checks and bots run again on the new commit.

## Merge when all of these hold

`VERDICT green` means the first three hold on the head:

- Every check passed on the current head commit.
- The PR's review bot has reviewed the PR's code. Either its status on the head commit is a success (or it said it skipped the commit), or **all** of these hold:
  - its status was a success on an earlier commit of this PR, and every finding from its reviews is answered;
  - every push since that commit changes only tests, docs or comments, or is a rebase onto `main` that left the PR's own code as reviewed.

  The digest checks this down to files: if only tests and docs changed since the reviewed commit, the `BOT` line says so and it counts. Comment-only code changes and rebases it leaves `pending`, listing the changed files; judge those yourself: `git diff <reviewed-sha> <head> -- . ':!*.md' ':!docs/**' ':!e2e/**' ':!**/*.test.ts' ':!**/*.test.tsx'` shows only comment lines, or `git range-diff <reviewed-sha>...<head>` shows the PR's commits unchanged. A rebase replaces the PR's commits, so find the reviewed one in the PR's timeline. Any other change in behaviour waits for the bot's status on the head.
- Every review comment has a reply, no review thread is unresolved, and no review is "changes requested".

And one only you can check:

- The PR description still matches what the PR does.

Then `gh pr merge <n> --squash --delete-branch`, update local `main`, and in T3 Code call `unwatch_pull_request` if you're handing back to the user.

## Limits

Stop and ask the user after 20 fix rounds or 2 hours on one PR. Never resolve a person's review thread, force-push a shared branch, or bypass a required check without the user's approval.
