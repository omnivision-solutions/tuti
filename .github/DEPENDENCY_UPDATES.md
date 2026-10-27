# Weekly dependency updates

`workflows/weekly-dependencies.yml` runs Claude Code every Monday (and by hand, from `main`, with **Run workflow**). It follows `prompts/weekly-dependencies.md`: update the npm dependencies in groups, run `pnpm typecheck`, `pnpm lint`, `pnpm test` and `pnpm build`, and write the pull request's description (what it updated, what it held back and why). One pull request, `Dependencies: weekly update`, goes up for review like any other; the database and browser suites run in its CI. While one is open, the next week's run does nothing.

## Setup

Two repository secrets, set once by a maintainer.

**`CLAUDE_CODE_OAUTH_TOKEN`**: a Claude subscription's token, so runs use the subscription and no API key. On your own machine, with Claude Code installed:

```sh
claude setup-token
```

It signs in through the browser and prints a token valid for a year. Then:

```sh
gh secret set CLAUDE_CODE_OAUTH_TOKEN --repo omnivision-solutions/tuti
```

and paste it at the prompt (it isn't echoed or saved in your shell history). Renew it the same way before it expires; a run fails at Claude Code's step when it has.

**`GH_DEPENDENCY_UPDATES_PAT`**: a fine-grained personal access token that opens the pull request (one opened with the workflow's own `GITHUB_TOKEN` wouldn't start CI). Create it at GitHub → Settings → Developer settings → Fine-grained tokens: resource owner the organization, only this repository, permissions **Contents: Read and write** and **Pull requests: Read and write**, and the longest expiry you're comfortable with. Then:

```sh
gh secret set GH_DEPENDENCY_UPDATES_PAT --repo omnivision-solutions/tuti
```

The first run can be a manual one: Actions → Weekly dependency updates → Run workflow.

## Security

- Schedule and manual dispatch only, on `main`: no pull request's code runs in this workflow, so fork code never meets its secrets. Its actions are pinned by commit SHA.
- Claude Code, and every install and build script it runs, is a separate unprivileged user holding only the Claude token: not the runner's tokens or files, and the GitHub write token isn't in that job at all.
- That job hands over only a patch and the description. A fresh job applies the patch with `scripts/apply-dependency-update.sh`, which rejects the whole update if it touches workflows, agent or review-bot instructions or env files: any dot file or directory (`.github/`, `.claude/`, `.env*`, `.coderabbit.yaml`, `.greptile/`, …), and AGENTS.md, CLAUDE.md, GEMINI.md, SKILL.md and `greptile.json` wherever they are, and only then uses the fine-grained token to push and open the pull request. Its test is `scripts/apply-dependency-update.test.ts`, in `pnpm test`.
- Claude's session isn't saved or uploaded, and nothing but the patch and the description is kept as an artifact (for a day).

## With Dependabot

Dependabot security updates stay on. They answer a security advisory the day it's published, with one pull request per vulnerable package, between weekly runs. The weekly update covers everything else on a schedule. They can overlap. If the weekly pull request lands first, Dependabot closes its own once the package is up to date. If Dependabot's lands first and the weekly one then conflicts in `pnpm-lock.yaml`, close the weekly one: the next run starts again from `main`.
