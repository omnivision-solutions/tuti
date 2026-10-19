# Plan

Living checklist. Items get ticked as they land; finished phases stay for history.

## Phase 0 — Foundation ✅

- [x] Name, domain (tuti.so), private repo `omnivision-solutions/tuti`, AGPL-3.0
- [x] Turborepo monorepo: `apps/web` (Next.js 16), `apps/worker` (Hatchet), `packages/db` (Prisma 7), `packages/shared`
- [x] Data model: project, member, board, post, vote, comment + Better Auth tables, `projectId` everywhere
- [x] Email/password auth, create project, public board with posting + voting
- [x] `post-created` background job (web → Hatchet → worker)
- [x] Secrets: Infisical "Tuti" project, `pnpm env:pull`, app stays secrets-manager-agnostic
- [x] Dev environment: `tuti_dev` database, Hatchet dev tenant, https://dev.tuti.so tunnel
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

Components live in `apps/web/src/components/ui`, on **Base UI**
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
  only apply to that portal. Accounts are global; only sessions are per host.

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

## Phase 4 — Verification foundation ✅

- [x] Vitest at the root; a setup file removes `DATABASE_URL`, `OPENAI_API_KEY` and `HATCHET_CLIENT_*` so tests can't reach real services by accident; a test checks that
- [x] `JOBS_DRIVER=inline`: `enqueue()` runs the worker task in-process (tests, E2E, and small self-hosted installs without Hatchet)
- [x] Fake embeddings: a local OpenAI embeddings server (`@tuti/testkit`, via `OPENAI_BASE_URL`) with hand-written vectors, so duplicate thresholds are tested exactly
- [x] `pnpm test:db`: Testcontainers starts `pgvector/pgvector:pg17` (locally and in CI, needs Docker), migrates a template database once and clones it per test file (`CREATE DATABASE … TEMPLATE`); parallel and isolated, never touches a shared database
- [x] Test helpers (`apps/web/src/test/helpers.ts`): sign up through Better Auth, create project / team member, call a server action as a given user (`actAs`), read where an action redirected
- [x] Authorization matrix (`apps/web/src/server/authorization.db.test.ts`): a typed list of every server action, checked by the compiler so new actions can't be missed; each must reject signed-out users, other projects' teams (also with their own slug and our ids), other projects' SSO users on portal actions, and too-low roles, without changing any data, and must work for the lowest allowed level
- [x] Backfill tests for what's already built (until now only run by hand): team rules, post numbers, SSO (incl. SSO users being refused dashboard actions), board renames and redirects, merging, duplicate suggestions; filters in the Playwright journey
- [x] Playwright (`pnpm test:e2e`): production build + inline jobs + a throwaway Postgres, portal hosts on `*.localhost`; journey: sign up → create project → two people post and vote on the portal → team merges the duplicate, comments, plans it → portal and team lists show the result and filter by status; numbered screenshot checkpoints in the report (a CI artifact)
- [x] CI (GitHub Actions): lint, typecheck, unit, db, e2e and build as separate required checks; a new push cancels the old run; `.only` fails CI (Vitest and Playwright)
- [x] Screenshots on PRs: after CI, a trusted workflow uploads the journey screenshots to S3-compatible storage (R2 bucket `tuti-ci`, public at `ci.tuti.so`, 30-day expiry) and posts them in one PR comment (like rakazo, which uses Hetzner Object Storage)
- [x] Journeys (with screenshots) for every screen: feedback + merge + filters, email verification, invites (by email, wrong account, dashboard), boards (create, change URL with redirect, delete, portal tabs), SSO (enable, sign-in, replayed token, disable), duplicates (typing suggestions, flagged list, panel, "Not a duplicate"), accounts (project switcher, account settings, sign-out and sign-in on the app and on a portal), Continue as, rich text, and the main team and portal screens at phone width and in dark mode (checked for sideways scrolling). New screens add their journey in the PR that builds them
- [x] AGENTS.md: test commands table, offline-by-default rule, PR rules (Why / What changed / How tested; prove a failure is unrelated by rerunning with the touched files restored to `main`; UI PRs link their screenshot; new user-facing copy is quoted in the PR)
- [x] `pr-watch` skill: wait for checks and review bots on the PR's latest commit (T3 Code's PR watch, else `gh pr checks --watch`), answer every finding, at most 20 rounds; never merge with open findings

## Phase 5 — Open source

- [x] Scan the whole git history for secrets and private infrastructure details (gitleaks + a manual pass); if anything turns up, rewrite or squash history before going public (approved)
- [x] Move maintainer-only notes (Infisical host and ids, servers) out of `docs/secrets.md`
- [x] README for self-hosters (Postgres with pgvector and pg_trgm, which a superuser must enable; Hatchet optional via inline jobs), CONTRIBUTING.md, SECURITY.md, issue templates
- [ ] CLA (CLA Assistant bot on PRs) before the first outside contribution, so Tuti can also be offered under a commercial licence
- [x] Make the repo public; `main` ruleset: required checks from Phase 4, squash-only, resolved review threads, no force pushes or deletion; secret scanning with push protection
- [x] Review bots: CodeRabbit (free for public repos; `.coderabbit.yaml`, follows AGENTS.md); Dependabot security updates
- [x] CI safety for forks: tests need no secrets; never run fork code with secrets (no `pull_request_target` checkouts)
- [ ] Dogfood: Tuti's own feedback portal for Tuti

## Phase 6 — First real users

- [x] Email: Nodemailer over SMTP (any provider, self-hosters included) behind one `sendEmail()` (`@tuti/email`), templates in React Email, written to the log when `SMTP_HOST` isn't set; database tests read mail from a local SMTP fake (`mailbox`). Templates for invites and notifications come with those features
- [x] Verify email on sign-up (link by email). Without it anyone can register someone else's address, so nothing may trust an unverified email. The link verifies and signs in; `/app` shows a "Verify your email" banner with resend until then
- [x] Invites by email address: owners/admins enter an email and a role; Tuti sends the link and also shows it to copy (installs without SMTP). Only a signed-in account with that email can accept; opening the emailed link proves they own the inbox, so it also marks the address verified. Up to 20 invites per project per day. Pending invites show on every `/app` page for verified addresses, with Accept / Decline
- [x] One account everywhere: people sign in once on the apex and see every project they're on (as today). On a portal, "Continue as <name>" signs them in with that same account: the portal sends them to the apex, which returns a one-time code (short-lived, single use, bound to that portal) that the portal exchanges for its own session. No cookie is ever shared with `*.tuti.so`: one bad portal page (or a custom domain) must never expose team sessions. Projects can still offer their own sign-in on their portal (SSO, email)
- [x] Landing page (no tests; checked by build and screenshot): what Tuti does today, an example board, what is on the way, links to sign up and GitHub
- [x] Production logging: `log` in `@tuti/shared` (one JSON line per entry in production, errors with message and stack; readable in dev); a unit test keeps `console` out of server and worker code
- [ ] Production: Dockerfiles, Coolify apps, prod values in Infisical; deploy when `main` is green; Coolify's health check (`/api/health`) gates each deploy. Done: Dockerfiles for web and worker (pruned, non-root, migrations at start, settings from env or Infisical), built in CI on every PR; Coolify apps for web (apex plus a `*.tuti.so` portal route) and worker, live since 2026-10-19; Coolify deploys every push to `main` (signed GitHub webhook; `main` only takes PRs that passed CI) and keeps the old version until `/api/health` passes. Left: Infisical identities in place of the copied env vars
- [x] `*.tuti.so` points at production, `--dev` hosts stay on the tunnel. DNS wildcards only cover whole labels, so once `*.tuti.so` goes to production each dev portal (`<project>--dev.tuti.so`) needs its own DNS record to the tunnel. Cloudflare Access protects only `dev.tuti.so` and `*--dev.tuti.so`; customer portals stay public

## Phase 6.5 — Rich content (editor + media)

One editor and one content format for posts, comments, changelog entries and help
center articles, each allowing only what it needs (posts get no buttons). Changelog
entries also become emails. Decided 2026-10-19: video by link embeds first (uploads
later if asked for); team members and portal users can upload images; default limits
10 MB per image for the team, 5 MB for portal users, 1 GB per project (all configurable).

- [ ] `@tuti/content`: Tiptap (MIT core) schema with one profile per use: `comment` (bold, italic, links, code), `post` (+ lists, code blocks, images, video embeds), `changelog` (+ headings, callouts, buttons, dividers), `article` (everything in `changelog` incl. headings, + tables, steps, code with a filename and tabs, collapsible details, file attachments, table of contents built from the headings). No custom HTML in any profile. Content is stored as ProseMirror JSON, never HTML; the server validates it against the profile and rejects anything the profile doesn't allow; plain text is derived for search, embeddings and previews. Done: the package with the `comment` and `post` profiles, validation (`parseDoc`), plain text both ways; `changelog` and `article` come with Phases 8 and 10
- [x] Safe links, one shared policy (tested): links only `http`, `https` and `mailto` (no `javascript:` or `data:`), opened with `rel="noopener noreferrer"`; video embeds only from an allowlist (YouTube, Loom, Vimeo) checked on the server, stored as provider + video id and rendered from a known embed URL in a sandboxed iframe, never the raw URL
- [x] Rendering from the same JSON: HTML on the server for pages, React Email for emails (images as JPEG, video embeds as a thumbnail linking to the post, email-safe buttons). Pages: `RichText`, React elements straight from the JSON, never HTML strings. Emails: `EmailRichText` in `@tuti/email` (inline styles, no iframes; images as the pipeline's email JPEG; a video becomes a "Watch the video" button linking to the post or entry, no thumbnail since Vimeo and Loom don't give one without an API call), used by the `changelogEmail` template, which nothing sends yet (that comes with emailing published entries to voters and subscribers, Phase 8). Buttons aren't a content node yet (`EmailRichText` skips unknown nodes); rendering them on pages and in emails is future work, with the `changelog` profile's buttons
- [x] Editor component: toolbar per profile, paste or drop images, per-image width (25/50/75/100%) and alignment (left/center/right), video embeds by URL (YouTube, Loom, Vimeo). Images also get alt text; pages load them from the media host with `srcset`
- [x] Posts and comments move to rich text: `content` holds the document and `body` its plain text (previews, search, embeddings). Posts from before keep `content` empty and render from `body`, so no data is rewritten
- [ ] Uploads: straight from the browser to S3-compatible storage with presigned URLs (R2 for tuti.so; any S3 for self-hosters, `MEDIA_*` env vars), served from a separate media domain that never sees session cookies. Limits enforced on the server: file size per role, project quota, per-user upload rate; SVG refused; files checked by content, not name. Done: presigned uploads (`@tuti/shared/storage`, size and type signed into the URL), the limits (30 uploads per person per hour), the S3 fake in `@tuti/testkit`; R2 buckets `tuti-media` (`media.tuti.so`) and `tuti-media-dev` (`media-dev.tuti.so`) with CORS for the app and portals; left: their S3 access keys (an R2 API token, made in the Cloudflare dashboard)
- [x] Image pipeline (background job, `image-uploaded`): re-encode with `sharp`, strip EXIF (location data), max 2400px, WebP sizes for pages plus a JPEG for email, width and height stored so pages don't jump; originals deleted after processing
- [ ] Cleanup: uploads never attached to content are deleted after a day; deleting content frees its media and quota. Done: the hourly `cleanup-media` job (Hatchet cron; installs without Hatchet keep unused uploads). Left: freeing media when content is deleted, once posts and comments can be deleted
- [ ] Tests: profile validation (unit), upload limits, quota and rate (database tests with an S3 fake), image pipeline on fixture images, journeys (a post with a resized and aligned image and a video embed; a changelog email rendered and screenshotted)
- [ ] Later: video uploads (transcoding), if people ask

## Phase 6.6 — API and MCP for everything

Every feature is an **operation** defined once (name, zod input, output, permission,
handler) and exposed three ways from that definition: the app (server actions call it),
a REST API and an MCP server, so they can't drift apart. Built before the shipped loop
so every later feature is API-first. (Asked for 2026-10-19.)

- [x] Operations layer: server actions become thin wrappers over operations that take an explicit actor (a signed-in user, or an API key acting as itself or on behalf of a project's user). Done: `defineOperation` (name, summary, method and path, scope, zod input, handler) with people (app) and API keys as actors and an access level (`team` or `anyone`); read operations `boards.list`, `posts.list`, `posts.get`, `comments.list`; team operations `posts.update` (status, board) and `posts.merge`, which the app's move, status and merge actions now call; `posts.create` and `comments.create`, which the app's post and comment forms now call. Keys write as their creator or on behalf of someone from the project's app (`author: { id, name, email }`, the same person as their SSO identity); `project.get`, `team.list`, `votes.set`, `duplicates.list` and `duplicates.dismiss` (the app's vote and "Not a duplicate" actions call them). Media over the API comes when someone needs it
- [x] Project API keys: created in settings, scoped read or read + write, shown once, stored hashed, revocable, rate-limited per key (600 a minute, `Retry-After`), up to 25 per project
- [x] REST API `/api/v1/…` generated from the operations (done: JSON errors `{error:{code,message}}`, Bearer keys, `/api/v1/openapi.json` (OpenAPI 3.1) and `/docs/api`, both generated from the operations), with an OpenAPI spec and a docs page; operations for everything built so far: projects (read), boards, posts, votes, comments, statuses, merging, duplicate suggestions, team (read), users from SSO, media (all but media)
- [x] MCP server (`/mcp`, Streamable HTTP, official SDK, stateless): every operation is a tool (`posts_list`, …; read-only keys see only read tools; errors come back as tool errors) (search and triage feedback, change status, merge duplicates; later draft changelogs, search help articles); API key as bearer token, OAuth later (for Claude.ai connectors)
- [x] Signed webhooks with retries (post created, status changed, comment created now; changelog published and article updated with Phases 8 and 10): settings card with "Send test", HMAC-SHA256 `Tuti-Signature: t=…,v1=…`, 8 retries with backoff over about a day, public HTTPS endpoints only (private and metadata addresses refused when saved and before each delivery, redirects not followed); each event has a stable id, sent on every retry (`Tuti-Event-Id` header and in the body), so receivers can ignore one they've already handled; documented as at-least-once delivery (from the Ferndesk review, 2026-10-19)
- [x] Authorization matrix covers every operation on every surface (UI, REST, MCP), checked by the compiler like today's server actions: `operations.db.test.ts` (read-only key reads but can't write, read and write key runs everything, another project's key reaches nothing), MCP's tool list per key, and the server actions matrix for the app
- [x] From then on (AGENTS.md rule): every feature PR adds its operations, so it ships in the UI, REST and MCP together
- [x] Tests: operations (database tests), OpenAPI matches the routes, MCP tools through the SDK's in-memory client, a journey that creates a key in the UI and calls the API with it

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

- [ ] Tuti GitHub App, installed per project on chosen repos; webhook endpoint verifies the signature and hands off to jobs (`github-pr`, `github-release`). Done: "Connect GitHub" in settings (signed, short-lived state; GitHub's user authorization proves the installer can see the installation, so nobody can claim another account's), uninstalling disconnects, the webhook endpoint checks `X-Hub-Signature-256`, a GitHub fake in `@tuti/testkit`. Left: the pull request and release jobs, and registering the App for tuti.so
- [x] `PostLink`: post ↔ PR / issue / release, with source (manual, reference, suggested); `links.add` / `links.remove` operations, shown in `posts.get`
- [x] Linking: references in PR title/body/commits (`tuti#123` or a post URL; done for titles, bodies and commit messages (on open and on every push), as `github-pull-request` jobs); embedding-based suggestions (PR text vs. open posts) the team confirms, same pattern as duplicate suggestions (done: the PR job embeds the PR's title and body and suggests up to 3 open, unlinked posts above `LINK_MIN_SIMILARITY`; "Maybe: acme/app#12 · title" with Link / Not related on the team's post view; `linkSuggestions.list`, `.accept`, `.dismiss` operations); manual "Link PR" on the post view (done: paste a PR, issue or release URL on the team's post view)
- [x] Status rules per project: linked PR opened → In progress (done: opened or reopened moves Open, Under review and Planned posts; edits only add links); release containing it (GitHub compare between tags) → Completed. Default closes on release, not merge — merged isn't shipped. Option to close on merge for projects without releases. Releases: `github-release` compares the previous release with this one (a repo's first release ships everything merged before it) and completes posts whose linked PRs it ships, linking the release; the App reads GitHub with an installation token (`GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY`). "Linked posts become Completed when … their pull request is merged" in settings for repos without releases
- [x] Optional PR comment listing the feedback a PR completes and its vote count: off by default ("Comment on pull requests with the feedback they complete" in settings; the App needs Pull requests: write). One comment per pull request, most voted first, updated as posts get linked; post titles are escaped so they can't mention people or add links; without write permission only the comment is skipped
- [x] Notify voters and commenters when their post ships: when a post becomes Completed (by the team, a merge or a release), its author, voters and commenters each get one email (a failed send is retried for those it missed), at verified addresses (or the one the project's SSO asserted); never the team. Each email has a per-project unsubscribe link and one-click `List-Unsubscribe` (RFC 8058); the link's page asks before unsubscribing, since link scanners open links
- [ ] Tests: [emulate](https://emulate.dev) GitHub emulator (app installs, signed webhooks, PRs, compare, releases) for db and E2E journeys; a `test:live` check against a real test repo

## Phase 8 — Roadmap + changelog, drafted from GitHub

The team edits and publishes; Tuti does the first draft from what actually merged.

- [x] Public roadmap on the portal: columns by status (Planned, In progress, Completed). Done: `/roadmap` on every portal (a "Roadmap" tab after the boards), most voted first, Completed by most recently finished, up to 50 per column, merged duplicates left out; `roadmap.get` operation
- [ ] Changelog entries (draft → published) at `/changelog`, with tags (New, Improved, Fixed) and the posts each entry completes; posts show "Shipped in vX". Written in the rich editor (`changelog` profile, Phase 6.5); published entries can go out as an email to voters and subscribers, rendered from the same content Done (API first): entries with tags (New, Improved, Fixed, Breaking) and the posts they complete, a `changelog` content profile (post + headings, quotes, dividers), `changelog.*` operations; publishing completes the posts (their people get the shipped email) and sends a `changelog.published` webhook. Left: the team's editor, the portal's `/changelog`, "Shipped in" on posts, email to subscribers
- [ ] Running draft: every merged PR is added to the next unpublished entry; a GitHub release (or "Ship" by hand) closes it out
- [ ] AI drafting (through OpenRouter, like Phase 11): rewrites PR titles/bodies into user-facing notes (what changed for users, not how), groups related PRs, leads with the posts it completes; skips internal work (labels like `chore`, `internal`, `deps`, configurable)
- [ ] Per-project style: a few example entries + tone notes the drafts follow
- [ ] Editor helpers: regenerate a section, shorten, "explain for non-developers"
- [ ] Optional: write the published notes back to the GitHub release body
- [ ] Without GitHub: write entries by hand and pick the posts they complete
- [ ] A "Breaking" tag next to New / Improved / Fixed; reader reactions on entries; an RSS feed for `/changelog` (from the Ferndesk review, 2026-10-19)
- [ ] Publishing asks "announce it" or "publish quietly"; announced entries show in the widget as unseen (Phase 9) (from the Ferndesk review, 2026-10-19)
- [ ] Tests: a model fake (scripted responses, checks every request, fails on unused steps) for drafting flows; a few real-model quality cases in `test:live` (no internal jargon, every completed post mentioned)

## Phase 9 — Widget + SDK (MIT)

- [ ] One script tag: give feedback (with duplicate suggestions), see what's new; signs users in with the existing JWT SSO
- [ ] Help center inside the widget: search and read articles, rendered from the same stored content as the help center, inside a Shadow DOM so the host site's selectors can't reach it and ours can't leak; the host element gets `all: initial` and the widget sets its own font, colours and sizes, since inherited properties still cross the boundary (asked for 2026-10-19)
- [ ] The widget talks to the public API (Phase 6.6), no private endpoints
- [ ] What's new: unseen badge for announced changelog entries, seen state per identified user (across devices) (from the Ferndesk review, 2026-10-19)
- [ ] Small SDK: `identify` (JWT), `open`, `openArticle` (also as a `data-` attribute for contextual help buttons), `hideLauncher`, `locale`, changelog unseen status; launcher, colours and up to 5 quick links set in `/app`; display as launcher, sidebar or inline (from the Ferndesk review, 2026-10-19)
- [ ] Tests: E2E on a fixture host page

## Phase 10 — Help center

- [ ] Collections and articles (rich editor, `article` profile from Phase 6.5; revision history), team editor in `/app`
- [ ] Portal `/help`: public, indexable; private articles for SSO users
- [ ] Search over article chunks with pgvector (reuses the embeddings pipeline); in the widget too
- [ ] Structure: sections (top tabs) → collections (nestable) → articles, ordered by drag and drop (from the Ferndesk review, 2026-10-19)
- [ ] Drafts with a diff before publishing; restore an earlier version or a deleted article; optional "Updated" date (from the Ferndesk review, 2026-10-19)
- [ ] Listing per article: everywhere / unlisted (link only) / hidden / AI only (used by answers, not listed) (from the Ferndesk review, 2026-10-19)
- [ ] Redirects when an article's URL changes (same pattern as boards and posts) (from the Ferndesk review, 2026-10-19)
- [ ] Found by search engines and AI tools: server-rendered pages, sitemap, per-article title and meta description, generated OG images, `llms.txt`, each article also at `/articles/<slug>.md`; restricted pages are noindex (from the Ferndesk review, 2026-10-19)
- [ ] Reader actions: copy as Markdown, open in ChatGPT / Claude; ⌘K search with "ask AI" in the same box (from the Ferndesk review, 2026-10-19)
- [ ] Article feedback (thumbs up/down with an optional comment) and search logging (hits and misses), shown as analytics: views, top articles, failed searches; these feed Phases 11 and 12 (from the Ferndesk review, 2026-10-19)
- [ ] Per-project branding for portals and the help center: logo (light/dark), favicon, primary colour, header and footer links; "Powered by Tuti" can be turned off (from the Ferndesk review, 2026-10-19)
- [ ] Access: a fully private portal; reader groups from the SSO token's attributes (e.g. plan = enterprise) that restrict collections and articles, shown locked or hidden; magic-link sign-in for portal users (from the Ferndesk review, 2026-10-19)
- [ ] Custom domains for portals and the help center (CNAME + automatic TLS), moved up from Later: a help center is worth little for SEO on a tuti.so subdomain (from the Ferndesk review, 2026-10-19)
- [ ] Export everything as a ZIP of Markdown (no lock-in) (from the Ferndesk review, 2026-10-19)

## Phase 11 — AI answers

- [ ] Answers from published articles, changelog and public posts only, with citations; says "I don't know" below a relevance threshold instead of guessing
- [ ] On portal `/help` and in the widget
- [ ] No answer → "Post this as feedback" (prefilled, with duplicate suggestions)
- [ ] Question log: unanswered and thumbs-down questions become a "Gaps" list for the team (feeds Phase 12)
- [ ] Assistant settings per project: tone, answer length, standing instructions, off-limits topics; replies in the asker's language; may show article images (from the Ferndesk review, 2026-10-19)
- [ ] Escalation to a person, when the project has set it up: hand the conversation to live chat or email support, with an AI summary of it (next to "Post this as feedback"). No separate contact form: the AI answers first and escalation covers the rest (decided 2026-10-19; replaces the widget contact form from the Ferndesk review)
- [ ] Coverage stats: answered / partly / not answered / escalated, per period (from the Ferndesk review, 2026-10-19)
- [ ] Models through OpenRouter (decided 2026-10-19; `OPENROUTER_API_KEY`, any OpenAI-compatible endpoint for self-hosters): Claude Haiku for cost, Sonnet where quality matters; per-project usage cap
- [ ] Tests: model fake for flows; `test:live` quality cases graded on facts (cites the right article, refuses when nothing matches)

## Phase 12 — Self-updating docs

Docs live in Tuti, not in the customer's repo; opening PRs against a docs repo
(docs-as-code) can come later if someone asks.

- [ ] Proposals: a diff against the current article (or a new draft) with the reason and source PR; team approves, edits or dismisses
- [ ] On merged PRs: find affected articles by embedding the PR text + diff, propose edits or a new article; the agent reads the repo read-only through the GitHub App
- [ ] From gaps: cluster unanswered questions, draft an article from them plus the code
- [ ] Opt-in scheduled check that each article's claims still match the code (expensive; weekly at most)
- [ ] PR screening controls: sensitivity (strict / balanced / eager), project guidance text, skip reverts, log "no docs change needed", dismiss with a reason (from the Ferndesk review, 2026-10-19)
- [ ] Verification statuses per article (up to date / needs review / can't verify) and "not an issue" remembered, so the check doesn't re-flag the same claim (from the Ferndesk review, 2026-10-19)
- [ ] Audit report: inputs are failed searches, thumbs-down articles, unanswered questions and the most-voted feedback posts (Tuti has the feedback natively; Ferndesk reads it from Featurebase) (from the Ferndesk review, 2026-10-19)
- [ ] "Ask the agent": a free-form task on an article or collection with sources (a PR, a link, a file), producing a proposal like the automatic ones (from the Ferndesk review, 2026-10-19)
- [ ] Tests: emulate GitHub repo contents + model fake; `test:live` cases on a fixture repo

## Later

- [ ] A proper parrot illustration (Phase 3.5 leftover)
- [ ] Support inbox, or hand-off to Intercom / Zendesk / Help Scout first
- [ ] More sources: GitLab, Linear, Jira; Slack notifications
- [ ] Turbo cache in CI, once jobs get slow (each takes 1–2 minutes now)
- [ ] Preview deployments per PR
- [ ] AI translations of the help center and widget, with a glossary; keep a locale on articles from the start (from the Ferndesk review, 2026-10-19)
- [ ] Import from other help centers (crawl a public URL, keep URLs with redirects) and feedback boards (Canny, Featurebase) (from the Ferndesk review, 2026-10-19)
- [ ] A generic "support endpoint" (JSON of conversations) as a source for docs gaps, before any native helpdesk integration (from the Ferndesk review, 2026-10-19)
- [ ] Slack and Linear: start an agent task ("draft docs from this thread") (from the Ferndesk review, 2026-10-19)
- [ ] Help center under a subfolder of the customer's site (`/help` via a proxy), after custom domains (from the Ferndesk review, 2026-10-19)
- [ ] More reader sign-in: OIDC, shared password; SAML/SCIM for teams (from the Ferndesk review, 2026-10-19)
- [ ] Reader MCP (search and ask the help center from AI tools) once Phase 11 exists (from the Ferndesk review, 2026-10-19)

Not planned, from the Ferndesk review (reasons): automated screenshots (browser automation with customer credentials, beta even there), an image editor (OS tools cover it), API reference pages and playground (another product), a Chrome extension (support-agent tooling), native ingestion from many helpdesks (the generic endpoint first), email-to-agent, multiple changelogs per project.
