# Plan

Living checklist. Items get ticked as they land; finished phases stay for history.

## Phase 0 — Foundation ✅

- [x] Name, domain (tuti.so), private repo `omnivision-solutions/tuti`, AGPL-3.0
- [x] Turborepo monorepo: `apps/web` (Next.js 16), `apps/worker` (Hatchet), `packages/db` (Prisma 7), `packages/shared`
- [x] Data model: workspace, member, board, post, vote, comment + Better Auth tables, `workspaceId` everywhere
- [x] Email/password auth, create workspace, public board with posting + voting
- [x] `post-created` background job (web → Hatchet → worker)
- [x] Secrets: Infisical "Tuti" project, `pnpm env:pull`, app stays secrets-manager-agnostic
- [x] Dev environment: `tuti_dev` database, Hatchet Cloud dev tenant, https://dev.tuti.so tunnel
- [x] End-to-end tests passing on dev (web + worker)

## Phase 1 — JWT SSO ✅

Customer apps sign a short-lived HS256 JWT with a per-workspace secret and redirect
users to `/<workspace>/sso?token=…&redirect=…`. Users are matched by `sub`, never by
email, so one workspace can't take over accounts in another.

- [x] Schema: workspace SSO secret, `SsoIdentity` (workspace + `sub` → user), used-token log for replay protection; migration
- [x] Better Auth plugin endpoint: verify token (signature, `exp`, max lifetime, one-time `jti`), find or create the user, set the session cookie, safe redirect
- [x] `/<workspace>/sso` route forwarding to the endpoint
- [x] Workspace settings page (owners/admins only): enable SSO, generate/rotate secret, integration snippet
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

## Phase 1.75 — URL structure: portals on subdomains (in progress)

- Apex (`tuti.so`): marketing at `/`, team sign-in/up, admin app at `/app/...`
- Portals: `<workspace>.tuti.so` (dev: `<workspace>--dev.tuti.so`, local:
  `<workspace>.localhost:3100`), later custom domains. Boards at `/b/<board>`,
  posts at `/p/<title>-<number>`, SSO at `/sso`.
- Sessions are per host (no cookies on `.tuti.so`), so portal sign-ins (incl. SSO)
  only apply to that portal.

- [ ] Config: `APP_URL` + `PORTAL_URL_TEMPLATE` (Infisical dev/prod, `.env.example`, startup check, turbo)
- [ ] `proxy.ts`: route portal hosts to internal portal routes; block portal routes on the apex
- [ ] Move admin pages to `/app` (workspace list, create, settings); apex `/` is marketing
- [ ] `/app` shell: shadcn sidebar with workspace switcher (switch / create) at the top, nav, account menu at the bottom
- [ ] Account settings page (`/app/account`: name, password)
- [ ] Portal pages: board list → `/b/<board>`, sign-in/up for end users
- [x] Per-workspace post numbers (`#123`) for `/p/<title>-<number>` URLs
- [ ] SSO moves to `<portal>/sso`; docs + settings snippet updated
- [ ] Better Auth trusts the apex and portal origins
- [ ] Reserved workspace slugs (www, app, api, admin, dev, docs, …); no `--`
- [ ] Dev: wildcard DNS `*.tuti.so` → tunnel, tunnel route, Next dev origins
- [ ] Tests updated and passing (local + through the tunnel); commit + push

Before production: `*.tuti.so` must point at production, with `--dev` hosts routed to
the tunnel (e.g. a Cloudflare origin rule). A Cloudflare cache rule already bypasses
caching for `dev.tuti.so` and `*--dev.tuti.so` (otherwise browsers keep stale dev CSS
for 4 hours).

## Phase 2 — Post pages & admin basics (next)

- [ ] Post page with comments
- [ ] Admins change post status
- [ ] Board sorting/filtering (top, new, by status)

## Phase 3 — Duplicates

- [ ] Admin "merge into…" (moves votes and subscribers without double counting)
- [ ] Similar-post suggestions while typing (full-text / trigram)
- [ ] Embedding-based detection in the `post-created` job (needs pgvector or a vector store — pgvector isn't on the shared Postgres server)

## Phase 4 — First real users

- [ ] Email (magic links, notifications) via the shared SMTP relay or a provider
- [ ] Landing page
- [ ] Production deployment: Dockerfiles (`infisical run` only when a token is set), Coolify apps, prod values in Infisical

## Later

- [ ] Roadmap view
- [ ] Changelog
- [ ] Help center / docs
- [ ] Support inbox
- [ ] Embeddable widget + MIT SDK
