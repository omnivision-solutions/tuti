# Plan

Living checklist. Items get ticked as they land; finished phases stay for history.

## Phase 0 — Foundation ✅

- [x] Name, domain (tuti.so), private repo `omnivision-solutions/tuti`, AGPL-3.0
- [x] Turborepo monorepo: `apps/web` (Next.js 16), `apps/worker` (Hatchet), `packages/db` (Prisma 7), `packages/shared`
- [x] Data model: project, member, board, post, vote, comment + Better Auth tables, `projectId` everywhere
- [x] Email/password auth, create project, public board with posting + voting
- [x] `post-created` background job (web → Hatchet → worker)
- [x] Secrets: Infisical "Tuti" project, `pnpm env:pull`, app stays secrets-manager-agnostic
- [x] Dev environment: `tuti_dev` database, Hatchet Cloud dev tenant, https://dev.tuti.so tunnel
- [x] End-to-end tests passing on dev (web + worker)

## Phase 1 — JWT SSO ✅

Customer apps sign a short-lived HS256 JWT with a per-project secret and redirect
users to `<project>.tuti.so/sso?token=…&redirect=…` (originally `/<project>/sso`). Users are matched by `sub`, never by
email, so one project can't take over accounts in another.

- [x] Schema: project SSO secret, `SsoIdentity` (project + `sub` → user), used-token log for replay protection; migration
- [x] Better Auth plugin endpoint: verify token (signature, `exp`, max lifetime, one-time `jti`), find or create the user, set the session cookie, safe redirect
- [x] SSO route forwarding to the endpoint (now on the portal host, see Phase 1.75)
- [x] Project settings page (owners/admins only): enable SSO, generate/rotate secret, integration snippet
- [x] Show the user's name (not email) in the header; SSO users get a placeholder email
- [x] Tests: happy path, same `sub` → same user, replay, expired, bad signature, overlong token, open redirect, non-admin access to settings
- [x] Docs: integration guide for customers (`docs/sso.md`)
- [x] Commit + push, verify on dev.tuti.so

## Phase 1.5 — UI foundation: shadcn/ui ✅

Components live in `apps/web/src/components/ui` (like Transcript LOL), on **Base UI**
(`base-nova` style), lucide icons, `next-themes` for light/dark.

- [x] Initialise shadcn in `apps/web` (Tailwind 4, CSS variables, light/dark)
- [x] Add base components (button, input, textarea, label, card, badge, alert, dropdown/sonner as needed)
- [x] Replace the hand-written UI (`.input`, `.btn-primary`) in every page and form
- [x] Typecheck, lint, build; check pages on dev.tuti.so (light + dark)
- [x] Commit + push

## Phase 1.75 — URL structure: portals on subdomains ✅

- Apex (`tuti.so`): marketing at `/`, team sign-in/up, admin app at `/app/...`
- Portals: `<project>.tuti.so` (dev: `<project>--dev.tuti.so`, local:
  `<project>.localhost:3100`), later custom domains. Boards at `/b/<board>`,
  posts at `/p/<title>-<number>`, SSO at `/sso`.
- Sessions are per host (no cookies on `.tuti.so`), so portal sign-ins (incl. SSO)
  only apply to that portal.

- [x] Config: `APP_URL` + `PORTAL_URL_TEMPLATE` (Infisical dev/prod, `.env.example`, startup check, turbo)
- [x] `proxy.ts`: route portal hosts to internal portal routes; block portal routes on the apex
- [x] Move admin pages to `/app` (project list, create, settings); apex `/` is marketing
- [x] `/app` shell: shadcn sidebar with project switcher (switch / create) at the top, nav, account menu at the bottom
- [x] Account settings page (`/app/account`: name, password)
- [x] Portal pages: board list → `/b/<board>`, sign-in/up for end users
- [x] Per-project post numbers (`#123`) for `/p/<title>-<number>` URLs
- [x] SSO moves to `<portal>/sso`; docs + settings snippet updated
- [x] Better Auth trusts the apex and portal origins
- [x] Reserved project slugs (www, app, api, admin, dev, docs, …); no `--`
- [x] Dev: wildcard DNS `*.tuti.so` → tunnel, tunnel route, Next dev origins
- [x] Tests updated and passing (local + through the tunnel); commit + push

Before production: `*.tuti.so` must point at production, with `--dev` hosts routed to
the tunnel (e.g. a Cloudflare origin rule). A Cloudflare cache rule already bypasses
caching for `dev.tuti.so` and `*--dev.tuti.so` (otherwise browsers keep stale dev CSS
for 4 hours).

## Phase 1.8 — Team members ✅

- [x] Invitations: owners/admins create an invite link with a role (email invites once email exists); invitee signs in or up on the apex and accepts
- [x] Team page (originally "Members") in `/app/<project>/team`: list, change role, remove, revoke pending invites
- [x] Rules: only owners manage owners; a project always keeps at least one owner; members can leave
- [x] Tests; commit + push

## Phase 1.9 — Naming and boards ✅

- [x] Rename workspaces → **projects** everywhere: UI, code, database (rename in place, keep data), routes, `PORTAL_URL_TEMPLATE` placeholder, docs
- [x] Rename members → **team** (team members with roles Owner / Admin / Member); people on portals are **users**
- [x] Multiple boards per project: Boards page in `/app` (create, rename, change URL with redirects, delete empty boards); board tabs on the portal; the default board is an ordinary board
- [x] Tests; commit + push

## Phase 2 — Post pages & team actions ✅

- [x] Post page `/p/<title>-<number>` on the portal, with comments (Team badge for the project's team)
- [x] Post view in `/app/<project>/p/<number>` for the team: comment (shown with a **Team** badge), change status, move to another board
- [x] Team members change post status from the feedback list too
- [x] Sorting and filtering in the URL: Feedback list (board, status, most votes / newest), portal boards (most votes / newest, status)

## Phase 3 — Duplicates ✅

- [x] Team "Merge into…": votes move to the original (people who voted on both count once), comments move too, the duplicate leaves all lists and its URL redirects to the original; earlier duplicates are re-pointed; no undo
- [x] Similar-post suggestions while typing a new post (`pg_trgm`, across boards)
- [x] Embeddings with OpenAI `text-embedding-3-small` in the `post-created` job, stored with pgvector; posts at ≥ 0.45 cosine similarity to an older post get a pending duplicate suggestion (top 3, same project). Optional: skipped without `OPENAI_API_KEY`. `pnpm --filter @tuti/worker backfill:embeddings` for existing posts
- [x] "Possible duplicates" for the team: on the post view with Merge / Dismiss, badge + filter in the Feedback list; merging clears its suggestions
- [x] Typing suggestions also use embeddings (≥ 0.40, queries of 10+ characters) when `OPENAI_API_KEY` is set; falls back to title matches if OpenAI fails

## Phase 3.5 — Design system ✅

- [x] Brand direction "Parrot" (picked from four options): green + beak-orange tokens for light and dark, Figtree + Bricolage Grotesque, parrot mark, favicon, "Powered by tuti" on portals
- [x] Shared layout components (`PageHeader`, `ItemList`/`ItemRow`, `EmptyState`, `BackLink`); every page moved onto them
- [x] `docs/design.md` rulebook and a dev-only `/design` gallery (light and dark side by side)
- [ ] A proper parrot illustration to replace the placeholder mark (moved to Later)

## How we work from Phase 4 on

Every change is a small PR (one topic, squash-merged) that CI proves before it lands:
lint, typecheck, unit, database and browser tests, production build. An agent opens
the PR, stays with it until checks and review bots finish, answers every finding
(fix it or rebut it with evidence), then merges. Each phase below lists the tests it
adds; a feature isn't done until its tests are in the PR.

Test layers (set up in Phase 4):

| Command | Real | Faked | Runs |
|---|---|---|---|
| `pnpm test` | product logic | everything external; no database, no keys | every PR |
| `pnpm test:db` | Postgres (pgvector, pg_trgm), Prisma, Better Auth, server actions, worker tasks | OpenAI, Hatchet (jobs run inline), email, GitHub | every PR |
| `pnpm test:e2e` | production build of web + inline jobs in a browser, portal subdomains on `*.localhost` | same as above | every PR |
| `pnpm test:live` | real OpenAI / Claude / GitHub / email | — | by hand; a missing key means "not run", never "passed" |

## Phase 4 — Verification foundation

- [x] Vitest at the root; a setup file removes `DATABASE_URL`, `OPENAI_API_KEY` and `HATCHET_CLIENT_*` so tests can't reach real services by accident; a test checks that
- [x] `JOBS_DRIVER=inline`: `enqueue()` runs the worker task in-process (tests, E2E, and small self-hosted installs without Hatchet)
- [x] Fake embeddings: a local OpenAI embeddings server (`@tuti/testkit`, via `OPENAI_BASE_URL`) with hand-written vectors, so duplicate thresholds are tested exactly
- [ ] `pnpm test:db`: Testcontainers starts `pgvector/pgvector:pg17` (locally and in CI, needs Docker), migrates a template database once and clones it per Vitest worker (`CREATE DATABASE … TEMPLATE`); parallel and isolated, never touches a shared database
- [ ] Test helpers (one shared set): sign up through Better Auth, create project / board / post / team member, call a server action as a given user
- [ ] Authorization matrix: a typed list of every server action, checked by the compiler so new actions can't be missed; each must reject signed-out users, other projects' members, and too-low roles
- [ ] Backfill tests for what's already built (until now only run by hand): SSO (happy path, same `sub`, replay, expiry, bad signature, open redirect), team rules (last owner, owners-only), board renames and redirects, post numbers, merging, duplicate suggestions, filters
- [ ] Playwright: production build + inline jobs, portal hosts on `*.localhost`; core journeys (sign up → create project → post → vote → team comments and changes status → merge duplicate); numbered screenshot checkpoints, uploaded with the report on failure and for UI PRs
- [ ] CI (GitHub Actions): lint, typecheck, unit, db, e2e, build as separate checks; turbo cache; a new push cancels the old run; `.only` fails CI; `no-console` in server and worker code
- [x] AGENTS.md: test commands table, offline-by-default rule, PR rules (Why / What changed / How tested; prove a failure is unrelated by rerunning with the touched files restored to `main`; UI PRs link their screenshot; new user-facing copy is quoted in the PR)
- [x] `pr-watch` skill: wait for checks and review bots on the PR's latest commit (T3 Code's PR watch, else `gh pr checks --watch`), answer every finding, at most 20 rounds; never merge with open findings

## Phase 5 — Open source

- [ ] Scan the whole git history for secrets and private infrastructure details (gitleaks + a manual pass); if anything turns up, rewrite or squash history before going public (approved)
- [ ] Move maintainer-only notes (Infisical host and ids, servers) out of `docs/secrets.md`
- [ ] README for self-hosters (Postgres with pgvector and pg_trgm, which a superuser must enable; Hatchet optional via inline jobs), CONTRIBUTING.md, SECURITY.md, issue templates
- [ ] CLA (CLA Assistant bot on PRs) before the first outside contribution, so Tuti can also be offered under a commercial licence
- [ ] Make the repo public; `main` ruleset: required checks from Phase 4, squash-only, no force pushes
- [ ] Review bots: CodeRabbit (free for public repos); Dependabot security updates
- [ ] CI safety for forks: tests need no secrets; never run fork code with secrets (no `pull_request_target` checkouts)
- [ ] Dogfood: Tuti's own feedback portal for Tuti

## Phase 6 — First real users

- [ ] Email: Nodemailer over SMTP (any provider, self-hosters included) behind one `sendEmail()`; templates in React Email; magic links, invitations, notifications; tests capture mail in memory
- [ ] Landing page (no tests; checked by build and screenshot)
- [ ] Production: Dockerfiles, Coolify apps, prod values in Infisical; deploy when `main` is green; a smoke test against production after each deploy
- [ ] `*.tuti.so` points at production, `--dev` hosts stay on the tunnel

## The "shipped loop" (Phases 7–11)

Code is the source of truth. One GitHub connection feeds everything after it: a
merged PR or a release closes the feedback it fixes, writes the changelog, proposes
doc updates, and the AI answers from those docs. Questions the AI can't answer
become doc drafts or feedback posts. (Inspired by Ferndesk's self-updating docs and
opendesk's help center + AI; neither closes feedback from releases.)

Rules for every AI feature: optional (off without an API key, like embeddings),
nothing customer-facing publishes without a team member's approval, every answer
or proposal shows its sources.

## Phase 7 — GitHub + auto-close

- [ ] Tuti GitHub App, installed per project on chosen repos; webhook endpoint verifies the signature and hands off to jobs (`github-pr`, `github-release`)
- [ ] `PostLink`: post ↔ PR / issue / release, with source (manual, reference, suggested)
- [ ] Linking: references in PR title/body/commits (`tuti#123` or a post URL); embedding-based suggestions (PR text vs. open posts) the team confirms, same pattern as duplicate suggestions; manual "Link PR" on the post view
- [ ] Status rules per project: linked PR opened → In progress; release containing it (GitHub compare between tags) → Completed. Default closes on release, not merge — merged isn't shipped. Option to close on merge for projects without releases
- [ ] Optional PR comment listing the feedback a PR completes and its vote count
- [ ] Notify voters and commenters when their post ships
- [ ] Tests: [emulate](https://emulate.dev) GitHub emulator (app installs, signed webhooks, PRs, compare, releases) for db and E2E journeys; a `test:live` check against a real test repo

## Phase 8 — Roadmap + changelog, drafted from GitHub

The team edits and publishes; Tuti does the first draft from what actually merged.

- [ ] Public roadmap on the portal: columns by status (Planned, In progress, Completed)
- [ ] Changelog entries (draft → published) at `/changelog`, with tags (New, Improved, Fixed) and the posts each entry completes; posts show "Shipped in vX"
- [ ] Running draft: every merged PR is added to the next unpublished entry; a GitHub release (or "Ship" by hand) closes it out
- [ ] AI drafting: rewrites PR titles/bodies into user-facing notes (what changed for users, not how), groups related PRs, leads with the posts it completes; skips internal work (labels like `chore`, `internal`, `deps`, configurable)
- [ ] Per-project style: a few example entries + tone notes the drafts follow
- [ ] Editor helpers: regenerate a section, shorten, "explain for non-developers"
- [ ] Optional: write the published notes back to the GitHub release body
- [ ] Without GitHub: write entries by hand and pick the posts they complete
- [ ] Tests: a model fake (scripted responses, checks every request, fails on unused steps) for drafting flows; a few real-model quality cases in `test:live` (no internal jargon, every completed post mentioned)

## Phase 9 — Widget + SDK (MIT)

- [ ] One script tag: give feedback (with duplicate suggestions), see what's new; signs users in with the existing JWT SSO
- [ ] Tests: E2E on a fixture host page

## Phase 10 — Help center

- [ ] Collections and articles (markdown, revision history), team editor in `/app`
- [ ] Portal `/help`: public, indexable; private articles for SSO users
- [ ] Search over article chunks with pgvector (reuses the embeddings pipeline); in the widget too

## Phase 11 — AI answers

- [ ] Answers from published articles, changelog and public posts only, with citations; says "I don't know" below a relevance threshold instead of guessing
- [ ] On portal `/help` and in the widget
- [ ] No answer → "Post this as feedback" (prefilled, with duplicate suggestions)
- [ ] Question log: unanswered and thumbs-down questions become a "Gaps" list for the team (feeds Phase 12)
- [ ] Claude for generation (Haiku for cost, Sonnet where quality matters); per-project usage cap
- [ ] Tests: model fake for flows; `test:live` quality cases graded on facts (cites the right article, refuses when nothing matches)

## Phase 12 — Self-updating docs

Docs live in Tuti, not in the customer's repo; opening PRs against a docs repo
(docs-as-code) can come later if someone asks.

- [ ] Proposals: a diff against the current article (or a new draft) with the reason and source PR; team approves, edits or dismisses
- [ ] On merged PRs: find affected articles by embedding the PR text + diff, propose edits or a new article; the agent reads the repo read-only through the GitHub App
- [ ] From gaps: cluster unanswered questions, draft an article from them plus the code
- [ ] Opt-in scheduled check that each article's claims still match the code (expensive; weekly at most)
- [ ] Tests: emulate GitHub repo contents + model fake; `test:live` cases on a fixture repo

## Later

- [ ] A proper parrot illustration (Phase 3.5 leftover)
- [ ] Support inbox, or hand-off to Intercom / Zendesk / Help Scout first
- [ ] More sources: GitLab, Linear, Jira; Slack notifications
- [ ] Preview deployments per PR
- [ ] Custom domains for portals
