# Secrets

Tuti only reads environment variables (`process.env`, plus the `.env` files Next.js,
Prisma and the worker load). It has no dependency on any secrets manager, so use
whatever you like: copy the `.env.example` files, or use Doppler, 1Password
(`op run`), direnv, your platform's env settings, etc.

The required variables are listed in each app's `.env.example` and checked on
startup (`assertEnv` in `apps/web/src/instrumentation.ts` and `apps/worker/src/index.ts`).
When adding a variable, update all three places:

1. the app's `.env.example`
2. the startup check, if it's required
3. `turbo.json` (`globalPassThroughEnv`), or Turborepo's strict env mode hides it from tasks

The rest of this document describes how the maintainers run Tuti with Infisical.
It's optional.

---

## Maintainers: Infisical

Source of truth is the maintainers' **Tuti** project on a self-hosted Infisical.
`pnpm env:pull` needs its location: set `INFISICAL_API_URL` and `INFISICAL_PROJECT_ID`
in your shell or in a gitignored `.env.infisical.local` at the repo root.

Environments: **`dev`** (what local `.env` files are generated from) and **`prod`**
(what deployed apps load).

### Layout

Rule: **each value is set in exactly one folder.** Anything used by more than one app
lives in `/shared`, which the others import.

| Folder | Holds | Local file (dev) |
|---|---|---|
| `/shared` | `DATABASE_URL`, `BETTER_AUTH_SECRET` (the worker signs the links it emails, as the web app does), `HATCHET_CLIENT_TOKEN`, `OPENAI_API_KEY` (embeddings), `OPENROUTER_API_KEY`, `APP_URL` (dev: the dev box's URL), `PORTAL_URL_TEMPLATE` (dev: `https://{project}.<dev box host>`), `SMTP_*` + `EMAIL_FROM` (Resend over SMTP from `mail.tuti.so`, port 587), `MEDIA_*`; prod also `APP_PORTAL_PROJECT`, `APP_PORTAL_OWNER` (the worker emails it when a project's email is paused), `CUSTOM_DOMAIN_TARGET` | — |
| `/web` ← shared | `MEDIA_LINK_SECRET`; dev also `ALLOWED_DEV_ORIGINS` (the dev box's host and its subdomains, `<host>,*.<host>`, matching `APP_URL` and `PORTAL_URL_TEMPLATE`); prod also `APP_WIDGET_PROJECT` (`help`: its widget in the team app; turn on SSO in that project to sign people in), `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ZONE_ID`, `TRUSTED_IP_HEADER`, `LICENSE_PRIVATE_KEY` (makes tuti.so the licence server; `scripts/license.mjs` sells licences), `DOMAIN_CONNECT_KEY` (signs one-click DNS links; its public half is TXT at `_dck1.tuti.so`, see `infra/domain-connect`) | `apps/web/.env` |
| `/worker` ← shared | nothing of its own | `apps/worker/.env` |
| `/scripts` ← shared (dev only) | `SHADOW_DATABASE_URL` (`tuti_dev_shadow`, for `prisma migrate dev`, since `tuti_dev` can't create databases) | `packages/db/.env` |

Use separate Hatchet tenants/tokens for `dev` and `prod`, so local runs never
pick up production jobs.

`DATABASE_URL` (dev) points at a `tuti_dev` database and role on a shared Postgres
(its superuser is only used to create roles and databases).

The dev databases have pgvector installed by the superuser in an `extensions` schema
(`CREATE SCHEMA extensions; CREATE EXTENSION vector SCHEMA extensions;`
`ALTER DATABASE … SET search_path TO "$user", public, extensions`). pgvector isn't a
trusted extension, and `prisma migrate dev` wipes the shadow database's `public` schema
before replaying migrations, so the extension has to live outside it.

`BETTER_AUTH_SECRET` and `MEDIA_LINK_SECRET` are generated separately per environment. Never change `MEDIA_LINK_SECRET`: it signs the image links in emails already sent. Empty values are
placeholders still to be filled in; the apps refuse to start while a required
variable is empty.

### Local development

```sh
infisical login   # once per machine
pnpm env:pull     # writes every app's .env from Infisical (scripts/env-pull.sh)
pnpm dev
```

The `.env` files are generated, so don't edit them. To change a value, edit it in
Infisical and pull again. For a value only you need, add a **personal override** on
the secret in Infisical, or put it in `apps/web/.env.local` (gitignored, loaded on
top of `.env` by Next.js).

The script passes `--projectId` and `--domain` explicitly, because the CLI ignores
`.infisical.json` when it authenticates with a machine token.

### Deployed apps

Each Docker image starts under
`infisical run --env=prod --path=/<app> --silent -- …` **only when `INFISICAL_TOKEN`
is set**, so the same image still works for self-hosters with plain env vars.
The host (Coolify) holds only `INFISICAL_TOKEN`, `INFISICAL_DOMAIN` and
`INFISICAL_PROJECT_ID`, never a copy of a value. Each app has its own machine identity
(`tuti-web`, `tuti-worker`): Universal Auth, no access to the rest of the org, the
project's Viewer role (read-only; a prod-only role would need Infisical Enterprise).
`INFISICAL_TOKEN` is an access token of that identity, made with a client secret
(Universal Auth's login) and set to last 10 years (its TTL and max TTL); the client
secret isn't kept. To replace a token (it's leaked, or it's running out): make a new
client secret for the identity, log in with it for a new access token, put that in
Coolify, redeploy, then revoke the old one. To change a value, edit it in Infisical and
redeploy the apps that use it; there's nothing to copy.

Infisical holds only what the apps read. The secret GitHub signs Coolify's deploy webhook
with lives in GitHub and Coolify alone; to change it, set a new one in both.

Coolify deploys `main` on every push, through a GitHub webhook signed with a
shared secret (Coolify's own auto-deploy; no Coolify token lives in GitHub). `main`
only changes through pull requests that passed CI, and Coolify keeps the running
version until the new one passes its health check (`/api/health`).

Builds don't need secrets (no `infisical run` in the build stage).
