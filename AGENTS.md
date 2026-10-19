# Tuti

Open-source feedback, roadmap and changelog tool. The plan and its checklist live in
`docs/plan.md`; tick items in the PR that delivers them. Design rules: `docs/design.md`.

## Checks

| Command | What it runs |
| --- | --- |
| `pnpm test` | Unit tests (Vitest). Offline: no database, OpenAI or Hatchet, whatever is in `.env` |
| `pnpm test:db` | Database tests (`*.db.test.ts`): server actions and jobs against a throwaway Postgres (Testcontainers, needs Docker) |
| `pnpm test:e2e` | Browser journeys (Playwright, `e2e/`) against the production build, a throwaway Postgres and inline jobs; portals on `<project>.localhost`. Needs Docker and `pnpm exec playwright install chromium` once |
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
- A change to a user-facing flow updates its journey in `e2e/` (or adds one). While a dialog is open the page behind it is hidden from role queries, so after a dialog action wait for its result (a toast, the URL) before asserting that something is gone. Journeys save numbered screenshots with `checkpoints()`; CI uploads them in the `playwright-report` artifact.
- Marketing pages get no tests; check them with a build and a screenshot.

## Pull requests

- One topic per PR, small enough to review in a few minutes. Squash-merged into `main`.
- The description says **Why** (the product reason), **What changed**, and **How tested**. Describe results in words; don't paste tool output.
- New user-facing text: quote it in the description and say why it's needed.
- UI changes: include a screenshot of the changed screen.
- A failing check you believe is unrelated: prove it by restoring the touched files to `main` and rerunning that test; say so in the PR.
- After opening a PR, follow `.claude/skills/pr-watch/SKILL.md`: stay with it until checks and review bots finish and every finding is answered. One exception, spelled out there: once CodeRabbit has passed the PR's code, pushes that only change tests, docs or comments (or rebase without changing the PR's code) can merge on green checks without waiting for its next review.

## Public repository

Tuti is open source: everything tracked, and every commit message, PR, issue and comment, is public. No secrets, `.env` files, real user data, private hostnames, account or project ids, or local paths. Use placeholders.

CI runs pull requests from forks, so it must never need secrets, and workflows never check out or run a pull request's code under `pull_request_target` (it has write access and secrets).

<!-- BEGIN:turborepo-agent-rules -->

# This is NOT the Turborepo you know

Turborepo configuration, task behavior, and CLI commands can vary between installed versions and may differ from your training data. Resolve the `turbo` package from this file's directory or relevant workspace; in monorepos, it may not be visible from the repository root. For example, run `node -p "require.resolve('turbo/package.json')"` from a workspace that depends on `turbo`.

Read `docs/README.md` inside that installed package first, then read the relevant pages from its `docs/` directory before changing Turborepo configuration or commands. Heed deprecation notices. These bundled docs match the installed package version and are available without network access.

This block is written and re-added by `turbo` before repository-scoped commands when an AI agent is detected. In the Turborepo source repository, its template is defined in `crates/turborepo-cli/src/cli/agent_guidance.rs`. Removing the managed block while updates are enabled means a later qualifying invocation will add it again. Set `"agentGuidance": false` in the root `turbo.json` or `turbo.jsonc` to opt out; this does not remove an existing block. Keep the block committed with your work to avoid an uncommitted change on the next agent invocation.
<!-- END:turborepo-agent-rules -->
