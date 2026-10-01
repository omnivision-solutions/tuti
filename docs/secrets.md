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

Source of truth is the **Tuti** project on self-hosted Infisical at
https://secrets.odev.us (project id `5bc28b50-3524-44d4-a145-33846604efd6`).
Same conventions as Vidkraken and Transcript LOL.

Environments: **`dev`** (what local `.env` files are generated from) and **`prod`**
(what deployed apps load).

### Layout

Rule: **each value is set in exactly one folder.** Anything used by more than one app
lives in `/shared`, which the others import.

| Folder | Holds | Local file (dev) |
|---|---|---|
| `/shared` | `DATABASE_URL`, `HATCHET_CLIENT_TOKEN` | — |
| `/web` ← shared | `BETTER_AUTH_SECRET`, `APP_URL` (dev: `https://dev.tuti.so`), `PORTAL_URL_TEMPLATE` (dev: `https://{project}--dev.tuti.so`) | `apps/web/.env` |
| `/worker` ← shared | nothing of its own | `apps/worker/.env` |
| `/scripts` ← shared (dev only) | `SHADOW_DATABASE_URL` (`tuti_dev_shadow`, for `prisma migrate dev`, since `tuti_dev` can't create databases) | `packages/db/.env` |

Use separate Hatchet Cloud tenants/tokens for `dev` and `prod`, so local runs never
pick up production jobs.

`DATABASE_URL` (dev) points at the `tuti_dev` database and role on "Database - Server 2"
(the Postgres from the Shared Infra project; the superuser is only used to create
roles and databases). It uses `sslmode=no-verify`: the connection is encrypted, but the
server's certificate is self-signed, so it isn't verified.

`BETTER_AUTH_SECRET` is generated separately per environment. Empty values are
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
`.infisical.json` when it authenticates with a machine token (as on the t3code box,
whose `infisical` wrapper uses the `t3code-box` identity).

### Deployed apps

Planned, matching the other projects: each Docker image starts under
`infisical run --env=prod --path=/<app> --silent -- …` **only when `INFISICAL_TOKEN`
is set**, so the same image still works for self-hosters with plain env vars.
The host (Coolify) holds only `INFISICAL_TOKEN`, `INFISICAL_DOMAIN` and
`INFISICAL_PROJECT_ID`, with one read-only machine identity per app
(`tuti-web`, `tuti-worker`).

Builds don't need secrets (no `infisical run` in the build stage).
