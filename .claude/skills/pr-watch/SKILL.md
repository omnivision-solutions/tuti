---
name: pr-watch
description: Stay with a pull request after opening or updating it until CI and review bots have finished on its latest commit and every finding is answered, then merge. Use after creating a PR, after pushing to one, or when asked to watch, babysit or land a PR.
---

# Watch a pull request until it can land

Passing checks alone don't mean a PR is done: review bots post after CI starts, and every finding needs an answer.

This repo's review bot is **CodeRabbit** (config in `.coderabbit.yaml`). It reviews every push, usually within a few minutes, and shows up as a `CodeRabbit` status on the commit. `main` only merges when every review thread is resolved.

## Wait without polling

- In T3 Code, call `watch_pull_request` with the PR URL and end your turn. You're woken when checks finish, someone comments or reviews, or the branch conflicts.
- Elsewhere, run `gh pr checks <number> --watch --fail-fast` as one background command. Never sleep-and-poll in the foreground.

## On each wake

1. **Check the head.** `gh pr view <n> --json headRefOid,mergeable,statusCheckRollup`. Results for an older commit don't count; if your local branch and the PR head differ, sync first.
2. **Failed checks.** Read the log before guessing: `gh run view <run-id> --log-failed`. Fix the cause and push. Before calling a failure unrelated or flaky, restore the touched files to `main`, rerun that test, and say what happened in the PR.
3. **Review comments.** List them: `gh api repos/{owner}/{repo}/pulls/<n>/comments` (inline) and `gh pr view <n> --comments` (conversation). Judge each on its merits; bots are confidently wrong often enough to check.
   - Real issue: fix it, push, then reply in the thread saying what changed.
   - Wrong: reply with the evidence (code, test, docs).
   - A product decision: ask the user.
   A comment is answered only when you've replied after its latest edit.
   - Resolving: once a bot's finding is fixed or answered, resolve its thread (CodeRabbit often resolves its own after the fix lands; `@coderabbitai resolve` resolves all of its threads). A person's thread is theirs to resolve: reply, and ask the user if it blocks the merge.
4. Repeat after every push. Each push restarts the wait: checks and bots run again on the new commit.

## Merge when all of these hold

- Every required check passed on the current head commit.
- CodeRabbit has finished reviewing that commit (its status isn't pending), or says it skipped it.
- Every review comment has a reply, every thread is resolved, and no review is "changes requested".
- The PR description still matches what the PR does.

Then `gh pr merge <n> --squash --delete-branch`, update local `main`, and in T3 Code call `unwatch_pull_request` if you're handing back to the user.

## Limits

Stop and ask the user after 20 fix rounds or 2 hours on one PR. Never resolve a person's review thread, force-push a shared branch, or bypass a required check without the user's approval.
