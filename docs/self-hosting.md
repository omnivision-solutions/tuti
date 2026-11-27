# Running Tuti yourself

How Tuti is built, how to run it for development, and how to host it on your own servers.
For what Tuti does, see the [README](../README.md) and [tuti.so](https://tuti.so).

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
  the database once before the first migration (`pg_trgm` and `btree_gin`, also used, ship with
  PostgreSQL and the migrations enable them themselves). The `pgvector/pgvector` Docker image has
  all three.
- Background jobs: a [Hatchet](https://hatchet.run) server (Hatchet Cloud or self-hosted,
  configured only through `HATCHET_CLIENT_*` env vars), or none with `JOBS_DRIVER=inline`
  (jobs run inside the web app; fine for small installs). Inline jobs run once, with no
  retries, so a failed webhook delivery or "shipped" email isn't tried again, and the scheduled
  jobs never run: unused uploads aren't deleted (storage only grows), deleted docs articles
  stay in the trash, docs search counts aren't trimmed to a year, and an API reference read
  from a URL is read again only on its Sync now (one from GitHub also when a pull request
  changing its file merges), not every 6 hours.
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
See [docs/secrets.md](secrets.md) (maintainers use Infisical via `pnpm env:pull`).

### Production routing (Tuti's cloud)

tuti.so is two apps on one domain, split by path on the server's proxy (Traefik): `/app`, `/api`, `/_tuti`
and `/help` (Tuti's own help center, the config file's `ownPortal.project`) go to the app (`apps/web`), whose domains are
those paths with the prefix kept (not stripped), and everything else to the marketing site
(`apps/marketing`), whose domain is all of `tuti.so` (the longer rule wins). Portals (`*.tuti.so`) and
customers' domains go to the app. The site's links into the app are plain paths on the same domain; its
pricing comes from the app's `/api/plans`, so plans and limits stay the app's settings. It needs one
variable, `APP_URL`: the app's public address (`https://tuti.so`; the app answers only on its own host). Its image:
`docker build -f apps/marketing/Dockerfile -t tuti-marketing .` (port 3000). In development each runs on
its own port, and the site's links go to the app's dev server. Both send page views to PostHog, cookieless,
when the config file has `analytics.posthogKey` (the same file as the app's, at `TUTI_CONFIG`, mounted into the site too);
a self-hosted server leaves it out and sends nothing. The site carries Tuti's own widget when `WIDGET_PROJECT` names its project (`help` on tuti.so);
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
| `OPENAI_BASE_URL` | Optional: the AI provider's OpenAI-compatible address, `https://openrouter.ai/api/v1` by default. Embeddings need OpenAI's `text-embedding-3-small` there (OpenAI serves it, and OpenRouter as `openai/text-embedding-3-small`); the start-up check says when the provider doesn't. Autopilot and Verify need OpenRouter's Decisions API, which only OpenRouter has: they're on at `openrouter.ai` or with an OpenRouter key (`sk-or-…`, e.g. through a proxy in front of OpenRouter), and off with another provider's key elsewhere, which the server logs at start-up. Generating images with AI needs OpenRouter the same way; its model is the config file's `ai.imageModel` |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_USERNAME`, `SMTP_PASSWORD`, `EMAIL_FROM` | Email (sign-up verification, invites) over any SMTP provider (Resend, SES, Postmark, your own server…). `EMAIL_FROM` is required with `SMTP_HOST`. Port 587 by default; some hosts block 465. Without `SMTP_HOST` emails are written to the log. With it, a password account signs in only once its address is verified (the emailed link), so accounts made before it was set must open that link (signing in sends it) |
| `EXPO_ACCESS_TOKEN` | Optional, worker (or web, with `JOBS_DRIVER=inline`): push notifications to the mobile app go through Expo's push service with no setup. Only for your own build of the app whose Expo project has enhanced push security on: its access token |
| `TRUSTED_IP_HEADER` | Set it behind a proxy: the header your proxy sets to the visitor's IP address (e.g. `cf-connecting-ip` behind Cloudflare; if it holds a list, the last value counts, the one your proxy added). It tells visitors apart for the limits on password sign-in, sign-up and verification emails, and for a per-visitor limit on emailed sign-in and password reset links (only a keyed hash of the address is stored, for an hour). Without it, sign-in limits go by `X-Forwarded-For`, which a visitor can set, and which puts everyone in one bucket when the proxy adds to it; emailed links have no per-visitor limit |
| `BROWSER_USE_API_KEY` | Optional, web and worker: Settings → Screenshots, where an agent in [Browser Use](https://browser-use.com)'s cloud browser signs in to a team's own app and takes screenshots of it (uploads must be set up too). Each run is charged in credits, what its browser session cost: the model and the browser's time, and the proxy's traffic for a project that turned on Use a residential proxy (off by default: runs use none). The agent's files are deleted from Browser Use once downloaded. Its model and cost cap are the config file's `screenshots` keys. Without it, the page says screenshots aren't available on this server |
| `TUTI_CONFIG` | Optional: the path of the config file, a JSON file of what you tune by feature (see below), on the web app and the worker alike (and the marketing site) |

Every app's `.env.example` lists its variables; the web app refuses to start without the
required ones. Put the app behind a proxy that passes `Host` and `X-Forwarded-*` headers.

**Upgrading (AI settings).** One provider now serves chat and embeddings. `OPENROUTER_API_KEY`
and `OPENROUTER_BASE_URL` are no longer read (the server warns at start-up if they're set): put the
key in `OPENAI_API_KEY`, and a provider other than OpenRouter's address in `OPENAI_BASE_URL`. A server with
only an OpenAI key in `OPENAI_API_KEY` keeps embeddings on OpenAI and chat off. A server that set
`OPENAI_BASE_URL` for embeddings alone now sends chat there too: that
endpoint must serve the config file's `ai.model` (or Tuti's default), and the server logs at start-up which model it
doesn't list. Autopilot and Verify stay off there: they need OpenRouter's Decisions API.

**AI levels.** A project runs each feature's AI on a level: Balanced is your server's models (the config file's
`ai.model` and `ai.features`), Custom is models the project picks. Affordable and Best need a row of models each, the
config file's `ai.levels` (a model id per role, by level; see `packages/shared/tuti.config.example.json`). Without
it, Tuti's own rows are used, unless you set a model (`ai.model` or a feature's, or Autopilot's): then only Balanced
and Custom are offered. Tuti's own Best row uses Claude Opus where the model writes (answers, drafted replies,
changelog entries, Autopilot's articles and checks) and Claude Sonnet for the rest; with `ai.maxPrice` under Opus's
price, Best isn't offered until you raise the cap or give Best cheaper models in `ai.levels`. The cap is checked when
a level is saved: a project already on Best keeps it, and runs on Opus, until it picks another level.

### The config file

What you tune, by feature, is in one JSON file: point `TUTI_CONFIG` at it, on the web app and the worker alike, and on the
marketing site if you run it (mount the same file into each). Secrets, and the addresses of the services Tuti uses
(its database, mail server, storage, AI provider), stay in env vars; no value is read from both: the keys in the
table below are file only. Every key is optional: what the file leaves out keeps its default, and without a file every value is its
default. `packages/shared/tuti.config.example.json` is an example, and `tuti.config.schema.json` beside it its JSON
Schema (`"$schema"` in the file gives editors completion and checks). A file that can't be read, isn't valid or has
a key Tuti doesn't know inside a section stops start-up, naming the key; so does an env var the file replaced, naming
its key. A whole section Tuti doesn't know is ignored, with a warning in the log.

**Upgrading when a release moves env vars into the file:** add their keys to the file first (the running release
ignores the new section), then upgrade with those variables removed: the new release refuses to start while one is
still set. The release that moved the AI variables (`ai`) is the exception: the one before it stops on a section it
doesn't know, so for that upgrade change the file and the variables in the same step as the upgrade.

| Key | Default | |
|---|---|---|
| `media.maxMb.teamImage` | `10` | An image the team uploads, in megabytes |
| `media.maxMb.userImage` | `5` | An image a reader uploads (to a post, a comment or a message), in megabytes |
| `media.maxMb.importImage` | `25` | An image an import copies from another tool, before it's re-encoded, in megabytes |
| `media.maxMb.teamFile` | `25` | A file the team attaches to an article, in megabytes |
| `media.maxMb.teamVideo` | `200` | A video the team uploads, in megabytes |
| `media.projectQuotaMb` | `1024` | All of a project's uploads together, in megabytes |
| `ai.model` | `null` | Every AI feature's model (an OpenRouter model id, or one your endpoint serves), where its own isn't set; Tuti's default without |
| `ai.features.answers` | `null` | AI answers' model, instead of `ai.model` |
| `ai.features.escalations` | `null` | Escalation summaries' model, instead of `ai.model` |
| `ai.features.support` | `null` | The inbox's drafted replies and summaries' model, instead of `ai.model` |
| `ai.features.changelog` | `null` | Changelog drafts' model, instead of `ai.model` |
| `ai.features.codeChanges` | `null` | Autopilot's articles' model, instead of `ai.model` (without either, Autopilot's write model) |
| `ai.features.translation` | `null` | Translating conversations' model, instead of `ai.model` (without either, openai/gpt-6.1-terra) |
| `ai.imageModel` | `"google/gemini-nano-banana-2.1"` | The AI image generator's model, an OpenRouter model that makes images in Gemini's aspect ratios (1:1 to 21:9, 1:8 and 8:1) at 1K, 2K and 4K (image_config). Image generation needs OpenRouter |
| `ai.maxPrice` | `null` | The most a model projects pick may cost, in dollars per million output tokens (a model without a price can't be picked under a cap); no cap without |
| `ai.levels` | `null` | The Affordable and Best levels' models, by role: a level left out isn't offered, a role left out runs on Balanced's (the server's) model. Without, Tuti's own rows, unless a model above is set (then only Balanced and Custom) |
| `autopilot.decisions.model` | `"nace-ai/drex-max"` | The decision model, a Decisions API model through OpenRouter (not a chat model): it answers the gate, what a pull request does to posts and articles, and whether edits call for Verify. The default did best on code changes' evaluation set (a model id) |
| `autopilot.decisions.gate` | `0.5` | The probability that users see the change, below which there's nothing to do (a number from 0 to 1) |
| `autopilot.decisions.resolves.maybe` | `0.4` | Resolving a post: proposed, as "maybe", from this probability (a number from 0 to 1) |
| `autopilot.decisions.resolves.likely` | `0.75` | Resolving a post: proposed as likely from this probability (a number from 0 to 1) |
| `autopilot.decisions.movesForward.maybe` | `0.4` | Moving a post forward: proposed, as "maybe", from this probability (a number from 0 to 1) |
| `autopilot.decisions.movesForward.likely` | `0.75` | Moving a post forward: proposed as likely from this probability (a number from 0 to 1) |
| `autopilot.decisions.links.maybe` | `0.65` | Linking a post: below this the pull request isn't linked to it at all (links are only applied by themselves, see `autopilot.decisions.autoLink`) (a number from 0 to 1) |
| `autopilot.decisions.links.likely` | `0.85` | Linking a post: an applied link is labelled likely from this probability (a number from 0 to 1) |
| `autopilot.decisions.autoLink` | `0.95` | A link Autopilot applies by itself from this probability (with "Link posts by itself" on); at least `autopilot.decisions.links.maybe` (a number from 0 to 1) |
| `autopilot.propose.edit.maybe` | `0.5` | Editing an article: proposed, as "maybe", from this probability (a number from 0 to 1) |
| `autopilot.propose.edit.likely` | `0.75` | Editing an article: proposed as likely from this probability (a number from 0 to 1) |
| `autopilot.propose.newArticle.maybe` | `0.3` | A new article: proposed, as "maybe", from this probability (a number from 0 to 1) |
| `autopilot.propose.newArticle.likely` | `0.8` | A new article: proposed as likely from this probability (a number from 0 to 1) |
| `autopilot.context.diffChars` | `60000` | The pull request's diff the docs agent and the writers read, in characters (the decision model at most 20,000 of it); files past it are only listed (a whole number from 1000 to 500000) |
| `autopilot.context.fileChars` | `6000` | One file's share of the diff at most, in characters (a whole number from 500 to 500000) |
| `autopilot.context.bodyChars` | `4000` | The pull request's description it reads, in characters (a whole number from 0 to 100000) |
| `autopilot.context.outlineArticles` | `1000` | The help center's articles and drafts the docs agent is shown at most (published ones first); it finds the rest with its search (a whole number from 50 to 20000) |
| `autopilot.decide.model` | `"anthropic/claude-haiku-5.5"` | The docs agent's model: with the tools, it decides what each merged pull request means for the help center (which articles to fix, which new ones it needs) in one answer (a model id) |
| `autopilot.decide.rounds` | `12` | Its rounds of tool calls at most, before it must answer (a whole number from 1 to 50) |
| `autopilot.decide.maxTokens` | `6000` | The most it writes in one reply, in tokens (the double-check's too) (a whole number from 500 to 64000) |
| `autopilot.decide.temperature` | `0` | Its temperature (the double-check's too): 0 for the steadiest answers (a number from 0 to 2) |
| `autopilot.decide.reasoning` | `"off"` | How much it thinks before each reply, as OpenRouter's reasoning effort (the double-check's too); off asks for none (one of off, low, medium, high) |
| `autopilot.redecide.model` | `"anthropic/claude-sonnet-5.5"` | The double-check's model: when the docs agent proposes a new article (see `autopilot.redecide.whenNewArticle`), it decides the pull request again from scratch, with the same tools, and its answer is used; it's also Checks' model on the Balanced level, which reviews every article edit. `off` skips both, and every article edit then asks first, except on a level whose `ai.levels` row or Custom setting gives Checks its own model (a model id, or off) |
| `autopilot.redecide.rounds` | `12` | Its rounds of tool calls at most, before it must answer (a whole number from 1 to 50) |
| `autopilot.redecide.whenNewArticle` | `0.2` | The double-check runs when the docs agent proposes a new article this sure or more (a number from 0 to 1) |
| `autopilot.write.model` | `"anthropic/claude-sonnet-5.5"` | The model that writes each edit and new article, with the same tools, and Autopilot's other text (the summary, reasons, the changelog line) and Verify's. A project's own pick for Autopilot wins, then `ai.features.codeChanges`, then `ai.model`, then this (a model id) |
| `autopilot.write.rounds` | `10` | Its rounds of tool calls at most, for each edit or new article (a whole number from 1 to 50) |
| `autopilot.write.maxTokens` | `6000` | The most it writes in one reply, in tokens (a whole number from 500 to 64000) |
| `autopilot.tools.listChars` | `30000` | List files: the answer's characters at most (a whole number from 1000 to 500000) |
| `autopilot.tools.fileChars` | `60000` | Read a file: its characters at most (a whole number from 1000 to 500000) |
| `autopilot.tools.searchLines` | `60` | Search the code: the lines at most (a whole number from 1 to 1000) |
| `autopilot.tools.searchChars` | `20000` | Search the code: the answer's characters at most (a whole number from 1000 to 500000) |
| `autopilot.tools.searchMs` | `5000` | Search the code: how long one search may take, in milliseconds (the model writes the pattern) (a whole number from 100 to 60000) |
| `autopilot.tools.articleChars` | `20000` | Read an article: its characters at most (a whole number from 1000 to 500000) |
| `autopilot.tools.articles` | `8` | Search articles: how many it finds when the model doesn't say (a whole number from 1 to 50) |
| `autopilot.tools.maxArticles` | `20` | Search articles: how many it finds at most (a whole number from 1 to 50) |
| `autopilot.tools.embedMs` | `30000` | Search articles: how long one embeddings request may take, in milliseconds (a whole number from 1000 to 300000) |
| `autopilot.limits.timeoutMinutes` | `10` | How long one pull request's analysis may take, in minutes; past it the analysis fails and is tried again (a whole number from 1 to 60) |
| `autopilot.limits.callTimeoutSeconds` | `120` | How long one request to the docs agent's models may take, in seconds (a whole number from 10 to 900) |
| `autopilot.limits.concurrentAnalyses` | `4` | How many pull requests the worker analyses at once, on the whole server (retries included); the rest wait their turn. Each holds a worker slot for up to the analysis's time limit, and its repository in memory (a whole number from 1 to 20) |
| `autopilot.limits.archiveBytes` | `50000000` | The repository's text the docs agent may read, in bytes; over it, it works from the diff (and the analysis says so) (a whole number from 1000000 to 1000000000) |
| `autopilot.limits.readBytes` | `1000000000` | The repository's archive unpacked, everything in it, in bytes at most (a whole number from 1000000 to 10000000000) |
| `autopilot.limits.fileBytes` | `1000000` | One file in the repository, in bytes at most; bigger ones are left out (a whole number from 10000 to 100000000) |
| `autopilot.limits.downloadMs` | `120000` | How long downloading the repository may take, in milliseconds (a whole number from 5000 to 900000) |
| `autopilot.verify.after` | `0.7` | How sure the decision model must be that edits piling up on an article call for Verify, before Autopilot starts one (a number from 0 to 1) |
| `ownPortal.project` | `""` | The project whose portal is under a path of the app's domain, the path being its slug ("help": /help/docs). Its slug may be a reserved one, like help (not one of the app's own paths, like api); empty: none |
| `ownPortal.owner` | `""` | The only address (verified) that can create `ownPortal.project`'s project; it also gets told when a project's email is paused. Empty: nobody |
| `ownPortal.widgetProject` | `""` | A project whose widget shows in the team app (never on portals); with SSO on there, it signs people in with their account. Empty: none |
| `customDomains.target` | `""` | The hostname customers point their domain at with a CNAME ("customers.example.com"); your proxy sends any host there to the app and gets it a TLS certificate. Empty: custom domains are off |
| `customDomains.cloudflareZoneId` | `""` | Cloudflare for SaaS gets the domains' certificates instead: its zone (Custom Hostnames on, fallback origin `customDomains.target`), with CLOUDFLARE_API_TOKEN. Empty: not used |
| `analytics.posthogKey` | `""` | PostHog's project key (a public one). Empty: nothing is sent |
| `analytics.posthogHost` | `"https://eu.i.posthog.com"` | PostHog's address |
| `credits.enabled` | `false` | Credits on: projects pay for AI, screenshots and emails past their plan's with prepaid credits (Tuti's cloud) |
| `credits.perTopupDollar` | `100` | Credits a dollar paid buys |
| `credits.perUsageDollar` | `100` | Credits a dollar of model cost spends (with perTopupDollar's default, no margin) |
| `credits.topupExpiryDays` | `365` | Whole days a top-up's credits last; 0: for good |
| `credits.free` | `0` | Credits every project is given once, lasting like a top-up |
| `credits.perEmail` | `0.2` | Credits each email past the plan's monthly allowance spends |
| `credits.low` | `100` | Under this balance owners and admins are emailed (and once it's out); 0: only once it's out |
| `duplicates.posted.model` | `"typesafe/jev-1.14"` | After a post is created: the decision model saying which of the 8 most similar posts it duplicates (they become "Possible duplicates"); OpenRouter only (elsewhere, and with `off`, similarity alone) |
| `duplicates.typing.model` | `"typesafe/jev-1.14"` | While a title is typed, on the portal and in the widget: the decision model saying which similar posts to suggest voting on instead; OpenRouter only (elsewhere, and with `off`, similarity alone) |
| `screenshots.model` | `"bu-4.0-mini"` | The agent's model, a Browser Use model id |
| `screenshots.retryModel` | `"bu-4.0"` | The model a run is tried once more with when the first fails as a whole (not when a screenshot or two weren't reached) |
| `screenshots.maxCostUsd` | `1` | The most one run may cost, in dollars, its retry included: Browser Use stops it there (a number above 0, at most 100) |
| `spam.decisions.model` | `"nace-ai/drex-max"` | Check 6: the decision model saying whether a new conversation is spam (at least 0.9 is, at most 0.3 isn't); OpenRouter only (elsewhere, and with `off`, check 7 alone) |
| `spam.chat.model` | `null` | Check 7: the chat model asked where the decision model wasn't sure (or without one): spam, not spam or unsure; `off` for none. Without, `ai.model`, then Tuti's default |
| `spam.requestsPerDay` | `200` | The most model requests the spam filter makes for one project in a day (UTC); past it, new conversations go to the inbox unchecked. 0 turns the model checks off |

### Autopilot's settings

The config file's `autopilot` keys (above): how Autopilot decides what a merged pull request
changes, and its docs agent's models, tools and time limits. Each has a default, so none needs
setting; change one to try another model, or the values that suit it, without a new release. Each
key's description ends with its range; a value outside it stops start-up, naming the key.

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

## License

[AGPL-3.0](../LICENSE), with [additional terms](../ADDITIONAL-TERMS.md) under its section 7: portals, and the
emails sent on a project's behalf, keep "Powered by tuti" unless the project has a current licence from Tuti for the installation that
serves it. Embeddable SDKs/widgets (when they exist) will be MIT,
without those terms.

### "Powered by tuti"

Portals say "Powered by tuti" in the footer, and so do the emails sent on a project's behalf (replies, shipped posts,
changelog entries, sign-in links and the like), under the same setting: hiding it hides both. Emails to a team about
Tuti itself always have it. Hiding it needs a licence for the project, bought on
tuti.so (a flat monthly fee per project, on tuti.so and self-hosted alike). Your installation then
fetches the licence key from tuti.so and renews it there, at most daily, after a portal page is
served.

Only projects an admin asked a licence for (Check now in Settings → Branding, or `POST /license/check` in the API) contact tuti.so, and
all they send is your installation's random id, the project's id, a one-time refresh token (from
the second request on; until then a random secret of your installation's, whose hash the "Get a licence" link carries, so only
your installation can claim the licence it bought), a random request id and the app version. If tuti.so can't be reached, the current key keeps working until it expires (35 days);
then the badge is back. A portal never stops working over a licence.

The badge links to `https://tuti.so/?utm_source=portal&utm_medium=powered_by&utm_campaign=badge` (`utm_source=widget`
in the widget), and in emails to `https://tuti.so/?utm_source=email&utm_medium=powered_by&utm_campaign=badge`, so tuti.so
can tell where a visit came from. The link names no project or installation, and the badge sends no referrer. In emails,
its mark is a picture from your installation (`/api/email-powered-by.png`), as is Tuti's logo in emails to teams.
