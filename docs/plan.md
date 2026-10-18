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
- [ ] A proper parrot illustration to replace the placeholder mark

## Phase 4 — First real users

- [ ] Email (magic links, notifications) via the shared SMTP relay or a provider
- [ ] Landing page
- [ ] Production deployment: Dockerfiles (`infisical run` only when a token is set), Coolify apps, prod values in Infisical

## The "shipped loop" (Phases 5–8)

Code is the source of truth. One GitHub connection feeds everything after it: a
merged PR or a release closes the feedback it fixes, writes the changelog, proposes
doc updates, and the AI answers from those docs. Questions the AI can't answer
become doc drafts or feedback posts. (Inspired by Ferndesk's self-updating docs and
opendesk's help center + AI; neither closes feedback from releases.)

Rules for every AI feature: optional (off without an API key, like embeddings),
nothing customer-facing publishes without a team member's approval, every answer
or proposal shows its sources.

## Phase 5 — GitHub + auto-close

- [ ] Tuti GitHub App, installed per project on chosen repos; webhook endpoint verifies the signature and hands off to Hatchet jobs (`github-pr`, `github-release`)
- [ ] `PostLink`: post ↔ PR / issue / release, with source (manual, reference, suggested)
- [ ] Linking: references in PR title/body/commits (`tuti#123` or a post URL); embedding-based suggestions (PR text vs. open posts) the team confirms, same pattern as duplicate suggestions; manual "Link PR" on the post view
- [ ] Status rules per project: linked PR opened → In progress; release containing it (GitHub compare between tags) → Completed. Default closes on release, not merge — merged isn't shipped. Option to close on merge for projects without releases
- [ ] Notify voters and commenters when their post ships (needs Phase 4 email)

## Phase 5.5 — Changelog, drafted from GitHub

The team edits and publishes; Tuti does the first draft from what actually merged.

- [ ] Entries (draft → published) on the portal at `/changelog`, with tags (New, Improved, Fixed) and the posts each entry completes; posts show "Shipped in vX"
- [ ] Running draft: every merged PR is added to the next unpublished entry, so the draft is ready when it's time to ship; a GitHub release (or "Ship" by hand) closes it out
- [ ] AI drafting: rewrites PR titles/bodies into user-facing notes (what changed for users, not how), groups related PRs, leads with the posts it completes; skips internal work (labels like `chore`, `internal`, `deps`, configurable)
- [ ] Per-project style: a few example entries + tone notes the drafts follow
- [ ] Editor helpers: regenerate a section, shorten, "explain for non-developers"
- [ ] Optional: write the published notes back to the GitHub release body
- [ ] Without GitHub: write entries by hand and pick the posts they complete

## Phase 6 — Help center

- [ ] Collections and articles (markdown, revision history), team editor in `/app`
- [ ] Portal `/help`: public, indexable; private articles for SSO users
- [ ] Search over article chunks with pgvector (reuses the embeddings pipeline)

## Phase 7 — AI answers

- [ ] Answers from published articles, changelog and public posts only, with citations; says "I don't know" below a relevance threshold instead of guessing
- [ ] Ask box on portal `/help` first; in-app via the widget later
- [ ] No answer → "Post this as feedback" (prefilled, with duplicate suggestions)
- [ ] Question log: unanswered and thumbs-down questions become a "Gaps" list for the team (feeds Phase 8)
- [ ] Claude for generation (Haiku for cost, Sonnet where quality matters); per-project usage cap

## Phase 8 — Self-updating docs

Docs live in Tuti, not in the customer's repo; opening PRs against a docs repo
(docs-as-code) can come later if someone asks.

- [ ] Proposals: a diff against the current article (or a new draft) with the reason and source PR; team approves, edits or dismisses
- [ ] On merged PRs: find affected articles by embedding the PR text + diff, propose edits or a new article; the agent reads the repo read-only through the GitHub App
- [ ] From gaps: cluster unanswered questions, draft an article from them plus the code
- [ ] Opt-in scheduled check that each article's claims still match the code (expensive; weekly at most)

## Later

- [ ] Roadmap view
- [ ] Embeddable widget + MIT SDK (feedback, help, AI answers in one script tag)
- [ ] Support inbox, or hand-off to Intercom / Zendesk / Help Scout first
- [ ] More sources: GitLab, Linear, Jira; Slack notifications
