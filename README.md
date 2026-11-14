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
  marketing/  tuti.so's marketing site (home, pricing, terms, privacy); Tuti's cloud only
packages/
  db/         Prisma schema, migrations and the shared client
  jobs/       Background job handlers and enqueue()
  shared/     Code shared by web + worker: job contracts, Hatchet client, env helpers
  testkit/    Test helpers and fakes (e.g. a local OpenAI embeddings server)
  ui/         What the app and the marketing site share: styles, brand fonts, a few components
  typescript-config/
```

Background jobs are defined as contracts (name + zod input) in `packages/shared/src/jobs.ts`
and implemented in `packages/jobs`. The web app starts them with `enqueue("postCreated", {...})`
(from `@tuti/jobs`); the worker runs them on Hatchet. With `JOBS_DRIVER=inline` they run inside
the web app instead, so small installs and tests don't need Hatchet.

## Getting started

Requirements:

- Node 22.22+ and pnpm (`corepack enable`)
- PostgreSQL (tested with 17) with the [pgvector](https://github.com/pgvector/pgvector) extension available.
  pgvector isn't a trusted extension, so a superuser must run `CREATE EXTENSION vector;` in
  the database once before the first migration (`pg_trgm`, also used, the migrations enable
  themselves). The `pgvector/pgvector` Docker image has both.
- Background jobs: a [Hatchet](https://hatchet.run) server (Hatchet Cloud or self-hosted,
  configured only through `HATCHET_CLIENT_*` env vars), or none with `JOBS_DRIVER=inline`
  (jobs run inside the web app; fine for small installs). Inline jobs run once, with no
  retries, so a failed webhook delivery or "shipped" email isn't tried again, and the scheduled
  jobs never run: unused uploads aren't deleted (storage only grows), deleted docs articles
  stay in the trash, and docs search counts aren't trimmed to a year.
- Optional: an AI provider for duplicate detection, docs search by meaning, AI drafting and
  answers, and Autopilot (`OPENAI_API_KEY`: an [OpenRouter](https://openrouter.ai) key, or any
  OpenAI-compatible provider's with `OPENAI_BASE_URL`). Without it, similar posts are still
  suggested by title and docs search matches words.

```bash
pnpm install

# Env files — fill in DATABASE_URL everywhere, BETTER_AUTH_SECRET (openssl rand -base64 32),
# and HATCHET_CLIENT_TOKEN (your Hatchet dashboard → Settings → API Tokens)
cp packages/db/.env.example packages/db/.env
cp apps/web/.env.example apps/web/.env
cp apps/worker/.env.example apps/worker/.env

pnpm db:migrate   # apply migrations
pnpm dev          # web on http://localhost:3100 + worker (+ the marketing site on :3000)
```

The app is at http://localhost:3100 (`/app` after signing in); each project's portal
is at `http://<project>.localhost:3100`. In production these are `APP_URL` and
`PORTAL_URL_TEMPLATE` (e.g. `https://tuti.so` and `https://{project}.tuti.so`, which
needs a wildcard DNS record).

A server's home (`/`) is its app. Tuti's cloud puts its marketing site there instead (below).

Prefer a secrets manager? Tuti only reads env vars, so any tool works.
See [docs/secrets.md](docs/secrets.md) (maintainers use Infisical via `pnpm env:pull`).

### Production routing (Tuti's cloud)

tuti.so is two apps on one domain, split by path on the server's proxy (Traefik): `/app`, `/api`, `/_tuti`
and `/help` (Tuti's own help center, `APP_PORTAL_PROJECT`) go to the app (`apps/web`), whose domains are
those paths with the prefix kept (not stripped), and everything else to the marketing site
(`apps/marketing`), whose domain is all of `tuti.so` (the longer rule wins). Portals (`*.tuti.so`) and
customers' domains go to the app. The site's links into the app are plain paths on the same domain; its
pricing comes from the app's `/api/plans`, so plans and limits stay the app's settings. It needs one
variable, `APP_URL`: the app's public address (`https://tuti.so`; the app answers only on its own host). Its image:
`docker build -f apps/marketing/Dockerfile -t tuti-marketing .` (port 3000). In development each runs on
its own port, and the site's links go to the app's dev server. Both send page views to PostHog, cookieless,
when `POSTHOG_KEY` is set (and `POSTHOG_HOST`, PostHog's EU cloud by default); a self-hosted server leaves it
unset and sends nothing. The site carries Tuti's own widget when `WIDGET_PROJECT` names its project (`docs`);
unset, it loads none.

## Self-hosting

Two Docker images, built from the repo root:

```bash
git clone https://github.com/omnivision-solutions/tuti
cd tuti
docker build -f apps/web/Dockerfile -t tuti-web .        # dashboard, portals, API; applies migrations at start
docker build -f apps/worker/Dockerfile -t tuti-worker .  # background jobs (skip with JOBS_DRIVER=inline)
```

Run them with the variables below (the web container listens on port 3000), for example from a `.env` file
in the repo root (one `NAME=value` per line, no quotes; Docker builds never read it):

```bash
docker run -p 3000:3000 --env-file .env tuti-web
```

Without
Docker: `pnpm install --frozen-lockfile && pnpm build`, then `pnpm --filter @tuti/db db:deploy`,
`pnpm --filter @tuti/web start` and `pnpm --filter @tuti/worker start`.

| Variable | |
|---|---|
| `DATABASE_URL` | Postgres connection string (web, worker, migrations) |
| `APP_URL` | Where the dashboard lives, e.g. `https://feedback.example.com` |
| `PORTAL_URL_TEMPLATE` | Where each project's portal lives, e.g. `https://{project}.feedback.example.com` (needs a wildcard DNS record and certificate) |
| `BETTER_AUTH_SECRET` | Random secret for sessions: `openssl rand -base64 32` |
| `HATCHET_CLIENT_TOKEN` | Hatchet API token (web and worker), or set `JOBS_DRIVER=inline` instead |
| `OPENAI_API_KEY` | Optional: AI (chat and embeddings), web and worker. An OpenRouter key (`sk-or-…`) needs nothing else; without `OPENAI_BASE_URL`, any other key is used for embeddings only, on OpenAI. At start-up the server checks the key and address and logs what looks wrong |
| `OPENAI_BASE_URL` | Optional: the AI provider's OpenAI-compatible address, `https://openrouter.ai/api/v1` by default. Embeddings need OpenAI's `text-embedding-3-small` there (OpenAI serves it, and OpenRouter as `openai/text-embedding-3-small`); the start-up check says when the provider doesn't. Autopilot and Verify need OpenRouter's Decisions API, which only OpenRouter has: they're on at `openrouter.ai` or with an OpenRouter key (`sk-or-…`, e.g. through a proxy in front of OpenRouter), and off with another provider's key elsewhere, which the server logs at start-up |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_USERNAME`, `SMTP_PASSWORD`, `EMAIL_FROM` | Email (sign-up verification, invites) over any SMTP provider (Resend, SES, Postmark, your own server…). `EMAIL_FROM` is required with `SMTP_HOST`. Port 587 by default; some hosts block 465. Without `SMTP_HOST` emails are written to the log |
| `TRUSTED_IP_HEADER` | Set it behind a proxy: the header your proxy sets to the visitor's IP address (e.g. `cf-connecting-ip` behind Cloudflare; if it holds a list, the last value counts, the one your proxy added). It tells visitors apart for the limits on password sign-in, sign-up and verification emails, and for a per-visitor limit on emailed sign-in and password reset links (only a keyed hash of the address is stored, for an hour). Without it, sign-in limits go by `X-Forwarded-For`, which a visitor can set, and which puts everyone in one bucket when the proxy adds to it; emailed links have no per-visitor limit |

Every app's `.env.example` lists its variables; the web app refuses to start without the
required ones. Put the app behind a proxy that passes `Host` and `X-Forwarded-*` headers.

**Upgrading (AI settings).** One provider now serves chat and embeddings. `OPENROUTER_API_KEY`
and `OPENROUTER_BASE_URL` are no longer read (the server warns at start-up if they're set): put the
key in `OPENAI_API_KEY`, and a provider other than OpenRouter's address in `OPENAI_BASE_URL`. A server with
only an OpenAI key in `OPENAI_API_KEY` keeps embeddings on OpenAI and chat off. A server that set
`OPENAI_BASE_URL` for embeddings alone now sends chat there too: that
endpoint must serve `AI_MODEL` (or Tuti's default), and the server logs at start-up which model it
doesn't list. Autopilot and Verify stay off there: they need OpenRouter's Decisions API.

### Autopilot's settings

Optional, on the web app and the worker alike: how Autopilot decides what a merged pull request
changes, and its docs agent's models, tools and time limits. Each has a default, so none needs
setting; change one to try another model, or the values that suit it, without a new release. Both apps check them when they start: a value
outside its range stops them, naming the variable, and a `CODE_CHANGES_` variable that names no
setting is logged as a likely typo. The values in use are logged at start, the changed ones marked.

| Variable | Default | Range | |
|---|---|---|---|
| `CODE_CHANGES_DECISIONS_MODEL` | `nace-ai/drex-max` | a model id | The decision model, a Decisions API model through OpenRouter (not a chat model): it answers the gate, what a pull request does to posts and articles, and whether edits call for Verify. The default did best on code changes' evaluation set. `DECISION_MODEL` still works; this wins if both are set |
| `CODE_CHANGES_DECISIONS_GATE` | `0.5` | a number from 0 to 1 | The probability that users see the change, below which there's nothing to do |
| `CODE_CHANGES_DECISIONS_RESOLVES_MAYBE` | `0.4` | a number from 0 to 1 | Resolving a post: proposed, as "maybe", from this probability |
| `CODE_CHANGES_DECISIONS_RESOLVES_LIKELY` | `0.75` | a number from 0 to 1 | Resolving a post: proposed as likely from this probability |
| `CODE_CHANGES_DECISIONS_MOVES_FORWARD_MAYBE` | `0.4` | a number from 0 to 1 | Moving a post forward: proposed, as "maybe", from this probability |
| `CODE_CHANGES_DECISIONS_MOVES_FORWARD_LIKELY` | `0.75` | a number from 0 to 1 | Moving a post forward: proposed as likely from this probability |
| `CODE_CHANGES_DECISIONS_LINKS_MAYBE` | `0.65` | a number from 0 to 1 | Linking a post: below this the pull request isn't linked to it at all (links are only applied by themselves, see `CODE_CHANGES_DECISIONS_AUTO_LINK`) |
| `CODE_CHANGES_DECISIONS_LINKS_LIKELY` | `0.85` | a number from 0 to 1 | Linking a post: an applied link is labelled likely from this probability |
| `CODE_CHANGES_DECISIONS_AUTO_LINK` | `0.95` | a number from 0 to 1 | A link Autopilot applies by itself from this probability (with "Link posts by itself" on); at least `CODE_CHANGES_DECISIONS_LINKS_MAYBE` |
| `CODE_CHANGES_PROPOSE_EDIT_MAYBE` | `0.5` | a number from 0 to 1 | Editing an article: proposed, as "maybe", from this probability |
| `CODE_CHANGES_PROPOSE_EDIT_LIKELY` | `0.75` | a number from 0 to 1 | Editing an article: proposed as likely from this probability |
| `CODE_CHANGES_PROPOSE_NEW_ARTICLE_MAYBE` | `0.3` | a number from 0 to 1 | A new article: proposed, as "maybe", from this probability |
| `CODE_CHANGES_PROPOSE_NEW_ARTICLE_LIKELY` | `0.8` | a number from 0 to 1 | A new article: proposed as likely from this probability |
| `CODE_CHANGES_CONTEXT_DIFF_CHARS` | `60000` | a whole number from 1000 to 500000 | The pull request's diff the docs agent and the writers read, in characters (the decision model at most 20,000 of it); files past it are only listed |
| `CODE_CHANGES_CONTEXT_FILE_CHARS` | `6000` | a whole number from 500 to 500000 | One file's share of the diff at most, in characters |
| `CODE_CHANGES_CONTEXT_BODY_CHARS` | `4000` | a whole number from 0 to 100000 | The pull request's description it reads, in characters |
| `CODE_CHANGES_CONTEXT_OUTLINE_ARTICLES` | `1000` | a whole number from 50 to 20000 | The help center's articles and drafts the docs agent is shown at most (published ones first); it finds the rest with its search |
| `CODE_CHANGES_DECIDE_MODEL` | `anthropic/claude-haiku-5.5` | a model id | The docs agent's model: with the tools, it decides what each merged pull request means for the help center (which articles to fix, which new ones it needs) in one answer |
| `CODE_CHANGES_DECIDE_ROUNDS` | `12` | a whole number from 1 to 50 | Its rounds of tool calls at most, before it must answer |
| `CODE_CHANGES_DECIDE_MAX_TOKENS` | `6000` | a whole number from 500 to 64000 | The most it writes in one reply, in tokens (the double-check's too) |
| `CODE_CHANGES_DECIDE_TEMPERATURE` | `0` | a number from 0 to 2 | Its temperature (the double-check's too): 0 for the steadiest answers |
| `CODE_CHANGES_DECIDE_REASONING` | `off` | one of off, low, medium, high | How much it thinks before each reply, as OpenRouter's reasoning effort (the double-check's too); off asks for none |
| `CODE_CHANGES_REDECIDE_MODEL` | `anthropic/claude-sonnet-5.5` | a model id, or off | The double-check's model: when the docs agent proposes a new article (see `CODE_CHANGES_REDECIDE_WHEN_NEW_ARTICLE`), it decides the pull request again from scratch, with the same tools, and its answer is used. `off` skips the double-check |
| `CODE_CHANGES_REDECIDE_ROUNDS` | `12` | a whole number from 1 to 50 | Its rounds of tool calls at most, before it must answer |
| `CODE_CHANGES_REDECIDE_WHEN_NEW_ARTICLE` | `0.2` | a number from 0 to 1 | The double-check runs when the docs agent proposes a new article this sure or more |
| `CODE_CHANGES_WRITE_MODEL` | `anthropic/claude-sonnet-5.5` | a model id | The model that writes each edit and new article, with the same tools, and Autopilot's other text (the summary, reasons, the changelog line) and Verify's. A project's own pick for Autopilot wins, then `AI_MODEL_CODE_CHANGES`, then `AI_MODEL`, then this |
| `CODE_CHANGES_WRITE_ROUNDS` | `10` | a whole number from 1 to 50 | Its rounds of tool calls at most, for each edit or new article |
| `CODE_CHANGES_WRITE_MAX_TOKENS` | `6000` | a whole number from 500 to 64000 | The most it writes in one reply, in tokens |
| `CODE_CHANGES_TOOLS_LIST_CHARS` | `30000` | a whole number from 1000 to 500000 | List files: the answer's characters at most |
| `CODE_CHANGES_TOOLS_FILE_CHARS` | `60000` | a whole number from 1000 to 500000 | Read a file: its characters at most |
| `CODE_CHANGES_TOOLS_SEARCH_LINES` | `60` | a whole number from 1 to 1000 | Search the code: the lines at most |
| `CODE_CHANGES_TOOLS_SEARCH_CHARS` | `20000` | a whole number from 1000 to 500000 | Search the code: the answer's characters at most |
| `CODE_CHANGES_TOOLS_SEARCH_MS` | `5000` | a whole number from 100 to 60000 | Search the code: how long one search may take, in milliseconds (the model writes the pattern) |
| `CODE_CHANGES_TOOLS_ARTICLE_CHARS` | `20000` | a whole number from 1000 to 500000 | Read an article: its characters at most |
| `CODE_CHANGES_TOOLS_ARTICLES` | `8` | a whole number from 1 to 50 | Search articles: how many it finds when the model doesn't say |
| `CODE_CHANGES_TOOLS_MAX_ARTICLES` | `20` | a whole number from 1 to 50 | Search articles: how many it finds at most |
| `CODE_CHANGES_TOOLS_EMBED_MS` | `30000` | a whole number from 1000 to 300000 | Search articles: how long one embeddings request may take, in milliseconds |
| `CODE_CHANGES_LIMITS_TIMEOUT_MINUTES` | `10` | a whole number from 1 to 60 | How long one pull request's analysis may take, in minutes; past it the analysis fails and is tried again |
| `CODE_CHANGES_LIMITS_CALL_TIMEOUT_SECONDS` | `120` | a whole number from 10 to 900 | How long one request to the docs agent's models may take, in seconds |
| `CODE_CHANGES_LIMITS_CONCURRENT_ANALYSES` | `4` | a whole number from 1 to 20 | How many pull requests the worker analyses at once, on the whole server (retries included); the rest wait their turn. Each holds a worker slot for up to the analysis's time limit, and its repository in memory |
| `CODE_CHANGES_LIMITS_ARCHIVE_BYTES` | `50000000` | a whole number from 1000000 to 1000000000 | The repository's text the docs agent may read, in bytes; over it, it works from the diff (and the analysis says so) |
| `CODE_CHANGES_LIMITS_READ_BYTES` | `1000000000` | a whole number from 1000000 to 10000000000 | The repository's archive unpacked, everything in it, in bytes at most |
| `CODE_CHANGES_LIMITS_FILE_BYTES` | `1000000` | a whole number from 10000 to 100000000 | One file in the repository, in bytes at most; bigger ones are left out |
| `CODE_CHANGES_LIMITS_DOWNLOAD_MS` | `120000` | a whole number from 5000 to 900000 | How long downloading the repository may take, in milliseconds |
| `CODE_CHANGES_VERIFY_AFTER` | `0.7` | a number from 0 to 1 | How sure the decision model must be that edits piling up on an article call for Verify, before Autopilot starts one |

## Scripts

| Command | |
|---|---|
| `pnpm dev` | Run web, worker and the marketing site in watch mode |
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

[AGPL-3.0](LICENSE), with [additional terms](ADDITIONAL-TERMS.md) under its section 7: portals keep
"Powered by tuti" unless the project has a current licence from Tuti for the installation that
serves it. Embeddable SDKs/widgets (when they exist) will be MIT,
without those terms.

### "Powered by tuti"

Portals say "Powered by tuti" in the footer. Hiding it needs a licence for the project, bought on
tuti.so (a flat monthly fee per project, on tuti.so and self-hosted alike). Your installation then
fetches the licence key from tuti.so and renews it there, at most daily, after a portal page is
served.

Only projects an admin asked a licence for (Check now in Settings → Branding, or `POST /license/check` in the API) contact tuti.so, and
all they send is your installation's random id, the project's id, a one-time refresh token (from
the second request on; until then a random secret of your installation's, whose hash the "Get a licence" link carries, so only
your installation can claim the licence it bought), a random request id and the app version. If tuti.so can't be reached, the current key keeps working until it expires (35 days);
then the badge is back. A portal never stops working over a licence.
