Update Tuti's npm dependencies in one reviewable batch. Read AGENTS.md first and follow it.

You run unattended in a GitHub Actions checkout of `main`, with Node 22 and pnpm on PATH and network access. No one can answer questions: decide, and explain your decisions in your final message.

## Updating

- See what's outdated across the workspace with `pnpm outdated -r`. Update in sensible groups that move together (Next.js with `eslint-config-next` and `@next/*`, Prisma's packages, Better Auth's, Playwright's, the type packages with their libraries), and keep `pnpm-lock.yaml` in step with `pnpm install`.
- Patch and minor releases: take them unless something breaks.
- Major releases need care. Read the release notes or changelog first. Take one only when its migration is small and the checks below pass; otherwise hold it back and say what the upgrade would involve.
- Before changing Turborepo's configuration or commands, read the docs bundled with the installed `turbo` package, as AGENTS.md's Turborepo block says.
- Keep `engines` and Node 22 support. Respect `pnpm-workspace.yaml`: don't add `minimumReleaseAgeExclude` entries (a release too new to install waits for next week) or allow new packages' build scripts.
- Fix code only as far as an update needs it, in the update's spirit. Never weaken a test, a type or a lint rule to make an update pass: hold the update back instead.
- Don't change anything under `.github/` or `.claude/`, AGENTS.md, CLAUDE.md, `.coderabbit.yaml`, `greptile.json` or any `.env*` file: the workflow rejects the whole update if you do. If a command rewrites one of them (turbo can rewrite its block in AGENTS.md), restore it with `git checkout -- <file>` and mention it in your final message so a maintainer can update it.

## Checking

Run, after `pnpm install` and `pnpm db:generate`:

- `pnpm typecheck`
- `pnpm lint`
- `pnpm test`
- `pnpm build`

All four must pass with your changes. If an update breaks one and you can't fix it properly, revert that update and hold it back. The Docker-based suites (`pnpm test:db`, `pnpm test:e2e`) don't run here: the pull request's CI runs them. Don't run `pnpm test:live`.

## Finishing

Leave your changes uncommitted in the checkout. Don't commit, push or open a pull request: the workflow takes the diff and opens the pull request itself. If nothing is worth updating, leave the checkout unchanged.

Your final message becomes the pull request's description, word for word, so make it only that, in Markdown with these sections:

- **Why**: one or two sentences (the weekly dependency update, and anything notable such as a security fix).
- **What changed**: what you updated, grouped, with versions (from → to), and any code you changed for an update and why.
- **Held back**: each update you didn't take, and why (a major needing a migration, a release too new, a check it broke).
- **How tested**: the checks you ran and their results, in words. Say that the database and browser suites are left to CI.

The repository is public: no secrets, tokens, local paths or account details in the description. Don't claim a check passed unless you ran it and it did.
