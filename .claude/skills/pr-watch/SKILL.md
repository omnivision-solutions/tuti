---
name: pr-watch
description: Stay with a pull request after opening or updating it until CI and review bots have finished on its latest commit and every finding is answered, then merge. Use after creating a PR, after pushing to one, or when asked to watch, babysit or land a PR.
---

# Watch a pull request until it can land

Passing checks alone don't mean a PR is done: review bots post after CI starts, and every finding needs an answer.

Each PR gets one review bot, so their rate limits last (`.github/workflows/review-bot.yml`): **Greptile** by default (`greptile.json`), or **CodeRabbit** (`.coderabbit.yaml`) when the PR has the `review:coderabbit` label. The label goes on by itself when Greptile says it can no longer review, or on every new PR while the `CODERABBIT_UNTIL` repository variable holds a later date; add it by hand to switch one PR (`gh pr edit <n> --add-label review:coderabbit`, then `@coderabbitai review` if no review starts). The PR's bot reviews every push, often 10–15 minutes each, and shows up as its status on the commit (Greptile's check, or `CodeRabbit`). Greptile's "Reactivate Greptile" notice is not a finding. `main` only merges when every review thread is resolved. Each push costs a review, so before opening or pushing: review your own diff for races, partial failures, retries and stale reads, run the full suites, and push fixes together rather than one at a time.

## Wait without polling

- In T3 Code, call `watch_pull_request` with the PR URL and end your turn. You're woken when checks finish, someone comments or reviews, or the branch conflicts.
- Elsewhere, run `gh pr checks <number> --watch --fail-fast` as one background command. Never sleep-and-poll in the foreground.

## On each wake

1. **Check the head.** `gh pr view <n> --json headRefOid,mergeable,statusCheckRollup`. Results for an older commit don't count; if your local branch and the PR head differ, sync first.
2. **Failed checks.** Read the log before guessing: `gh run view <run-id> --log-failed`. Fix the cause and push. Before calling a failure unrelated or flaky, restore the touched files to `main`, rerun that test, and say what happened in the PR.
3. **Review comments.** List them: `gh api --paginate repos/{owner}/{repo}/pulls/<n>/comments` (inline) and `gh pr view <n> --comments` (conversation). Judge each on its merits; bots are confidently wrong often enough to check.
   - Real issue: fix it, push, then reply in the thread saying what changed.
   - Wrong: reply with the evidence (code, test, docs).
   - A product decision: ask the user.
   A comment is answered only when you've replied after its latest edit.
   - Resolving: once a bot's finding is fixed or answered, resolve that thread (CodeRabbit often resolves its own after the fix lands). Resolve one thread at a time with the GraphQL `resolveReviewThread` mutation; `@coderabbitai resolve` resolves *all* of CodeRabbit's threads, so use it only once every one of them is handled. A person's thread is theirs to resolve: reply, and ask the user if it blocks the merge.
   - Thread state isn't in the REST comment list. Check it with:
     `gh api graphql --paginate -f query='query($o:String!,$r:String!,$n:Int!,$endCursor:String){repository(owner:$o,name:$r){pullRequest(number:$n){reviewThreads(first:100,after:$endCursor){pageInfo{hasNextPage endCursor} nodes{id isResolved comments(first:1){nodes{author{login} path body}}}}}}}' -f o=<owner> -f r=<repo> -F n=<n>`
4. Repeat after every push. Each push restarts the wait: checks and bots run again on the new commit.

## Merge when all of these hold

- Every required check passed on the current head commit.
- The PR's review bot has reviewed the PR's code. Either its status on the head commit is a success (or it said it skipped the commit), or **all** of these hold:
  - its status was a success on an earlier commit of this PR, and every finding from its reviews is answered;
  - every push since that commit changes only tests, docs or comments, or is a rebase onto `main` that left the PR's own code as reviewed. Check it: `git diff <reviewed-sha> <head> -- . ':!*.md' ':!docs/**' ':!e2e/**' ':!**/*.test.ts' ':!**/*.test.tsx' ':!**/*.db.test.ts'` shows only comment lines; for a rebase, `git range-diff <reviewed-sha>...<head>` shows the PR's commits unchanged.

  Any other change in behaviour waits for the bot's status on the head. Pending, failed or missing means not reviewed yet: check that the status is there, not only that nothing failed (a check that filters for failures passes when the status is missing).
- Every review comment has a reply, the GraphQL query above shows no unresolved thread, and no review is "changes requested".
- The PR description still matches what the PR does.

Then `gh pr merge <n> --squash --delete-branch`, update local `main`, and in T3 Code call `unwatch_pull_request` if you're handing back to the user.

## Limits

Stop and ask the user after 20 fix rounds or 2 hours on one PR. Never resolve a person's review thread, force-push a shared branch, or bypass a required check without the user's approval.
