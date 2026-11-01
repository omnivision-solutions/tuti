# Tuti

Open-source feedback, roadmap and changelog tool. The plan and its checklist live in
`docs/plan.md`; tick items in the PR that delivers them. Design rules: `docs/design.md`.

## Checks

| Command | What it runs |
| --- | --- |
| `pnpm test` | Unit tests (Vitest). Offline: no database, OpenAI or Hatchet, whatever is in `.env` |
| `pnpm test:db` | Database tests (`*.db.test.ts`): server actions and jobs against a throwaway Postgres (Testcontainers, needs Docker) |
| `pnpm test:e2e` | Browser journeys (Playwright, `e2e/`) against the production build, a throwaway Postgres and inline jobs; portals on `<project>.localhost`. Ports 3200 (a self-hosted server) and 3201 (Tuti's cloud, selling plans); set `E2E_PORT` (it and the next port) to run two checkouts at once. Needs Docker and `pnpm exec playwright install chromium` once |
| `pnpm test:live` | Real services, by hand: code changes' evaluation set against the decision model (`DECISION_MODEL`, or the default), with `OPENROUTER_API_KEY`. Skipped without the keys: not run, never passed. CI doesn't run it |
| `pnpm typecheck` | TypeScript across the monorepo |
| `pnpm lint` | ESLint |
| `pnpm build` | Production builds |

CI runs all of them on every PR. Run the ones your change touches before pushing.

## Tests

- Every change that alters behaviour comes with a test that fails without it. Bug fixes start with that failing test.
- Tests are deterministic and offline. External services get a local fake (see `@tuti/testkit`), never a real key; background jobs run with `JOBS_DRIVER=inline`.
- Database tests get a fresh database per file, so they need no cleanup. Use the helpers in `apps/web/src/test/helpers.ts` (`signUp`, `actAs`, `createProject`, …) and call server actions directly. Never point tests at a shared or production database.
- A new server action goes into the authorization matrix (`apps/web/src/server/authorization.db.test.ts`); typecheck fails until it does.
- Features are operations (`apps/web/src/server/operations`): defined once, they're served in the REST API, MCP and the API docs, and the app calls them from thin server actions. A new operation goes into the operations matrix (`apps/web/src/server/operations/operations.db.test.ts`); typecheck fails until it does.
- Emails the app sends land in a local SMTP fake: in database tests read them with `mailbox` (`apps/web/src/test/mailbox.ts`), in journeys with `latestEmailTo` (`e2e/mail.ts`).
- Test data uses `e2e-…@example.com` emails.
- A change to a user-facing flow updates its journey in `e2e/` (or adds one). While a dialog is open the page behind it is hidden from role queries, so after a dialog action wait for its result (a toast, the URL) before asserting that something is gone. Journeys save numbered screenshots with `checkpoints()`; CI uploads them in the `playwright-report-*` artifacts, one per shard.
- Marketing pages get no tests; check them with a build and a screenshot.

## Database migrations

- A deploy runs the previous release beside the new schema for a while: the web container applies migrations when it starts, while the old web container and the worker keep running, and self-hosters update the same way. Prisma reads every column it knows about, so each migration must keep working with the previous release's code. Add tables, nullable or defaulted columns, and enum values first; drop, rename, retype or make columns required only in a later release, once no released code uses them.
- `packages/db/src/migrations.test.ts` fails on those statements. When one is safe (nothing released reads it any more), put a `-- Previous release: <why it's safe>` comment directly above it.

## Pull requests

- One topic per PR, small enough to review in a few minutes. Squash-merged into `main`.
- The description says **Why**, **What changed**, and **How tested**. Why is the product reason: what was wrong and what this changes, never `<name> wants` or a briefing about a named person; the maintainer is the author. Describe results in words; don't paste tool output.
- New user-facing text: quote it in the description and say why it's needed.
- UI changes: include a screenshot of the changed screen.
- A failing check you believe is unrelated: prove it by restoring the touched files to `main` and rerunning that test; say so in the PR.
- Before opening a PR, if you have Claude Code, run the local Claude review in `.claude/skills/pr-watch/SKILL.md` and fix what holds up; without it, skip that step. After opening it, follow that skill: stay with it until checks and review bots finish and every finding is answered. A PR whose `Review risk #<n>` status is low doesn't wait for its review bot (CodeRabbit on odd-numbered PRs, Greptile on even ones); its findings after the merge open an issue to answer. One more exception, spelled out there: once the PR's review bot has passed the PR's code, pushes that only change tests, docs or comments (or rebase without changing the PR's code) can merge on green checks without waiting for its next review.

## Public repository

Tuti is open source: everything tracked, and every commit message, PR, issue and comment, is public. No secrets, `.env` files, real user data, or anything that identifies a person, machine or account: local paths, usernames, private hostnames, account emails, signing identities, legal entity names, or account, project, key, issuer or tenant ids. Use placeholders. No business metrics either (analytics, traffic, click-through, conversion, signup, revenue or star-growth numbers): give the product reason in words, even when data motivated the change.

CI runs pull requests from forks, so it must never need secrets, and workflows never check out or run a pull request's code under `pull_request_target` (it has write access and secrets).

<!-- BEGIN:turborepo-agent-rules -->

# This is NOT the Turborepo you know

Turborepo configuration, task behavior, and CLI commands can vary between installed versions and may differ from your training data. Resolve the `turbo` package from this file's directory or relevant workspace; in monorepos, it may not be visible from the repository root. For example, run `node -p "require.resolve('turbo/package.json')"` from a workspace that depends on `turbo`.

Read `docs/README.md` inside that installed package first, then read the relevant pages from its `docs/` directory before changing Turborepo configuration or commands. Heed deprecation notices. These bundled docs match the installed package version and are available without network access.

This block is written and re-added by `turbo` before repository-scoped commands when an AI agent is detected. In the Turborepo source repository, its template is defined in `crates/turborepo-cli/src/cli/agent_guidance.rs`. Removing the managed block while updates are enabled means a later qualifying invocation will add it again. Set `"agentGuidance": false` in the root `turbo.json` or `turbo.jsonc` to opt out; this does not remove an existing block. Keep the block committed with your work to avoid an uncommitted change on the next agent invocation.
<!-- END:turborepo-agent-rules -->
