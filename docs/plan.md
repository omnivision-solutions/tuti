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

## Phase 1 — JWT SSO (in progress)

Customer apps sign a short-lived HS256 JWT with a per-workspace secret and redirect
users to `/<workspace>/sso?token=…&redirect=…`. Users are matched by `sub`, never by
email, so one workspace can't take over accounts in another.

- [ ] Schema: workspace SSO secret, `SsoIdentity` (workspace + `sub` → user), used-token log for replay protection; migration
- [ ] Better Auth plugin endpoint: verify token (signature, `exp`, max lifetime, one-time `jti`), find or create the user, set the session cookie, safe redirect
- [ ] `/<workspace>/sso` route forwarding to the endpoint
- [ ] Workspace settings page (owners/admins only): enable SSO, generate/rotate secret, integration snippet
- [ ] Show the user's name (not email) in the header; SSO users get a placeholder email
- [ ] Tests: happy path, same `sub` → same user, replay, expired, bad signature, overlong token, open redirect, non-admin access to settings
- [ ] Docs: integration guide for customers
- [ ] Commit + push, verify on dev.tuti.so

## Phase 2 — Post pages & admin basics

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
