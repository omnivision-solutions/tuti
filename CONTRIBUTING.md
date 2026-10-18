# Contributing to Tuti

Thanks for helping! Bug fixes, tests and docs are always welcome. For a new feature,
open an issue first so we can agree on the shape before you build it.

## Setup

Follow [Getting started](README.md#getting-started). The test suites also need Docker
(they start their own Postgres) and, for browser tests, `pnpm exec playwright install chromium`.

## Checks

| Command | |
| --- | --- |
| `pnpm test` | Unit tests, offline |
| `pnpm test:db` | Server actions and jobs against a throwaway Postgres |
| `pnpm test:e2e` | Browser journeys against the production build |
| `pnpm typecheck`, `pnpm lint`, `pnpm build` | |

CI runs all of them on every pull request, and they must pass before merging. CI needs no
secrets: tests never call real services (OpenAI, Hatchet and others get local fakes).

## Rules

The full list lives in [AGENTS.md](AGENTS.md) (written for AI coding agents, and just as
true for people). The short version:

- Every change in behaviour comes with a test that fails without it.
- A new server action goes into the authorization matrix (`apps/web/src/server/authorization.db.test.ts`).
- A change to a user-facing flow updates its journey in `e2e/`.
- One topic per pull request, small enough to review in a few minutes.
- The description says **why**, **what changed** and **how you tested it**; UI changes include a screenshot.

AI-assisted contributions are welcome and held to the same bar.

## Contributor License Agreement

Before your first pull request can be merged, you'll be asked to sign our CLA (a bot
comments on the pull request with a link). It lets the project offer Tuti under other
licences too, alongside AGPL-3.0; you keep the copyright to your work.
