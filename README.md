# Tuti

Open-source feature voting & product feedback. Collect feature requests, let users vote, and close the loop.

Each project gets a public portal on its own subdomain (boards, posts, votes, comments,
sign-in through your app with JWT SSO) and a dashboard for the team (statuses, merging
duplicates with AI suggestions, boards, team roles). Next up: GitHub, so merged PRs and
releases close the feedback they fix and draft your changelog. See [the plan](docs/plan.md).

## Stack

| | |
|---|---|
| Monorepo | [Turborepo](https://turborepo.com) + pnpm workspaces |
| Web | [Next.js 16](https://nextjs.org) (App Router), Tailwind CSS 4 |
| Auth | [Better Auth](https://better-auth.com) (email + password for now) |
| Database | PostgreSQL via [Prisma 7](https://www.prisma.io) (`@prisma/adapter-pg`) |
| Background jobs | [Hatchet](https://hatchet.run) (Hatchet Cloud or self-hosted), or inline |
| Language | TypeScript 6 |

## Layout

```
apps/
  web/        Next.js app (UI, server actions, Better Auth routes)
  worker/     Hatchet worker (background tasks)
packages/
  db/         Prisma schema, migrations and the shared client
  jobs/       Background job handlers and enqueue()
  shared/     Code shared by web + worker: job contracts, Hatchet client, env helpers
  testkit/    Test helpers and fakes (e.g. a local OpenAI embeddings server)
  typescript-config/
```

Background jobs are defined as contracts (name + zod input) in `packages/shared/src/jobs.ts`
and implemented in `packages/jobs`. The web app starts them with `enqueue("postCreated", {...})`
(from `@tuti/jobs`); the worker runs them on Hatchet. With `JOBS_DRIVER=inline` they run inside
the web app instead, so small installs and tests don't need Hatchet.

## Getting started

Requirements:

- Node 22.12+ and pnpm (`corepack enable`)
- PostgreSQL (tested with 17) with the [pgvector](https://github.com/pgvector/pgvector) extension available.
  pgvector isn't a trusted extension, so a superuser must run `CREATE EXTENSION vector;` in
  the database once before the first migration (`pg_trgm`, also used, the migrations enable
  themselves). The `pgvector/pgvector` Docker image has both.
- Background jobs: a [Hatchet](https://hatchet.run) server (Hatchet Cloud or self-hosted,
  configured only through `HATCHET_CLIENT_*` env vars), or none with `JOBS_DRIVER=inline`
  (jobs run inside the web app; fine for small installs).
- Optional: an OpenAI API key for duplicate detection and docs search by meaning
  (`OPENAI_API_KEY`). Without it, similar posts are still suggested by title and docs
  search matches words.

```bash
pnpm install

# Env files — fill in DATABASE_URL everywhere, BETTER_AUTH_SECRET (openssl rand -base64 32),
# and HATCHET_CLIENT_TOKEN (your Hatchet dashboard → Settings → API Tokens)
cp packages/db/.env.example packages/db/.env
cp apps/web/.env.example apps/web/.env
cp apps/worker/.env.example apps/worker/.env

pnpm db:migrate   # apply migrations
pnpm dev          # web on http://localhost:3100 + worker
```

The app is at http://localhost:3100 (`/app` after signing in); each project's portal
is at `http://<project>.localhost:3100`. In production these are `APP_URL` and
`PORTAL_URL_TEMPLATE` (e.g. `https://tuti.so` and `https://{project}.tuti.so`, which
needs a wildcard DNS record).

Prefer a secrets manager? Tuti only reads env vars, so any tool works.
See [docs/secrets.md](docs/secrets.md) (maintainers use Infisical via `pnpm env:pull`).

## Self-hosting

Two Docker images, built from the repo root:

```bash
docker build -f apps/web/Dockerfile -t tuti-web .        # dashboard, portals, API; applies migrations at start
docker build -f apps/worker/Dockerfile -t tuti-worker .  # background jobs (skip with JOBS_DRIVER=inline)
```

Run them with the variables below (the web container listens on port 3000). Without
Docker: `pnpm install --frozen-lockfile && pnpm build`, then `pnpm --filter @tuti/db db:deploy`,
`pnpm --filter @tuti/web start` and `pnpm --filter @tuti/worker start`.

| Variable | |
|---|---|
| `DATABASE_URL` | Postgres connection string (web, worker, migrations) |
| `APP_URL` | Where the dashboard lives, e.g. `https://feedback.example.com` |
| `PORTAL_URL_TEMPLATE` | Where each project's portal lives, e.g. `https://{project}.feedback.example.com` (needs a wildcard DNS record and certificate) |
| `BETTER_AUTH_SECRET` | Random secret for sessions: `openssl rand -base64 32` |
| `HATCHET_CLIENT_TOKEN` | Hatchet API token (web and worker), or set `JOBS_DRIVER=inline` instead |
| `OPENAI_API_KEY` | Optional: duplicate detection and docs search with embeddings |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_USERNAME`, `SMTP_PASSWORD`, `EMAIL_FROM` | Email (sign-up verification, invites) over any SMTP provider (Resend, SES, Postmark, your own server…). `EMAIL_FROM` is required with `SMTP_HOST`. Port 587 by default; some hosts block 465. Without `SMTP_HOST` emails are written to the log |
| `TRUSTED_IP_HEADER` | Optional: the header your proxy sets to the visitor's IP address (e.g. `cf-connecting-ip` behind Cloudflare), for a per-visitor limit on emailed sign-in and password reset links. Only a keyed hash of the address is stored, for an hour. Without it there's no per-visitor limit |

Every app's `.env.example` lists its variables; the web app refuses to start without the
required ones. Put the app behind a proxy that passes `Host` and `X-Forwarded-*` headers.

## Scripts

| Command | |
|---|---|
| `pnpm dev` | Run web + worker in watch mode |
| `pnpm build` | Build all apps |
| `pnpm test` | Unit tests (offline) |
| `pnpm test:db` | Database tests on a throwaway Postgres (needs Docker) |
| `pnpm test:e2e` | Browser journeys against the production build (needs Docker; `pnpm exec playwright install chromium` once) |
| `pnpm typecheck` | Type-check every package |
| `pnpm lint` | Lint |
| `pnpm db:migrate` | Create/apply a migration (`prisma migrate dev`) |
| `pnpm db:studio` | Open Prisma Studio |
| `pnpm env:pull` | Maintainers: generate `.env` files from Infisical |

## Data model

Every domain table carries `projectId`, so one deployment can host many projects.

- `Project` (incl. JWT SSO secret), `TeamMember` (with roles), `Invitation`, `Board`, `BoardRedirect` (old board URLs)
- `SsoIdentity` (project + your app's user id → Tuti user), `SsoTokenUse` (one-time token ids)
- `Post` (with denormalised `voteCount`, `status`, `duplicateOfId` for merges), `Vote`, `Comment`
- `PostEmbedding` (pgvector), `DuplicateSuggestion`
- Better Auth tables: `User`, `Session`, `Account`, `Verification`

Auth tables are generated by Better Auth. After changing the auth config (e.g. adding plugins), regenerate with
`npx auth@latest generate` and merge the changes into `packages/db/prisma/schema.prisma`.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Security issues: [SECURITY.md](SECURITY.md).

## License

[AGPL-3.0](LICENSE). Embeddable SDKs/widgets (when they exist) will be MIT.

### "Powered by tuti"

Portals say "Powered by tuti" in the footer. Hiding it needs a licence for the project, bought on
tuti.so (a flat monthly fee per project, on tuti.so and self-hosted alike). Your installation then
fetches the licence key from tuti.so and renews it there, at most daily, after a portal page is
served.

Only projects an admin asked a licence for (Check now in Settings → Branding, or `POST /license/check` in the API) contact tuti.so, and
all they send is your installation's random id, the project's id, a one-time refresh token (from
the second request on), a random request id and the app version. If tuti.so can't be reached, the current key keeps working until it expires (35 days);
then the badge is back. A portal never stops working over a licence.
