---
name: test-audit
description: Gate every test you add or change, audit an area's tests for low-value proof, and fix flaky tests at their cause. Use when writing, changing, reviewing, pruning or de-flaking tests (unit, db or journeys). For a whole area's cleanup, read CAMPAIGN.md first.
---

# Test audit

Every test costs CI time on every PR, and CI is Tuti's bottleneck. A test earns that cost by
failing when a user-visible behaviour or an independent contract breaks, and only then.
AGENTS.md's test rules still apply; this skill adds the bar a test must clear.

- Adding or changing a test: the authoring gate below.
- Pruning an area's tests: the gate, the junk patterns and the retention bar, one area per PR;
  a whole area at once is a campaign ([CAMPAIGN.md](CAMPAIGN.md)).
- A flaky test: [Flaky tests](#flaky-tests).

## Authoring gate

Before adding a test, or keeping one in an audit, answer:

1. **What does it protect?** An observable behaviour (what a user, a reader, an API caller or
   a job sees) or an independent contract (below).
2. **What credible regression makes it fail?** Name the change to the code. If none would, it
   protects nothing.
3. **Why doesn't existing proof catch that?** Each contract has one owner, at the strongest
   boundary that can see it:
   - an operation's behaviour: its db test, calling it the way the app does (`callerAs`,
     `actAs` and the server action, or the REST/MCP route), not its internals;
   - who may call it: the authorization matrix (`apps/web/src/server/authorization.db.test.ts`)
     and the operations matrix (`apps/web/src/server/operations/operations.db.test.ts`);
   - who may open a page: `pages-authorize.db.test.ts` (until T12 folds it into the matrix);
   - a screen's flow: its journey in `e2e/`;
   - a pure helper's edge cases: its unit test.

   Another layer earns a second test only for a risk the first can't see (the browser, a
   stream, a redirect, a job's retry). Add a row to an existing table or `it.each` before
   writing a new test; share setup through `apps/web/src/test/helpers.ts`, not copies.
4. **Does it need a seam with no production caller?** An export, flag, parameter, reset
   function or wrapper only a test uses. Then test at the real boundary instead, and delete
   the seam.

A regression test fails before the fix for the intended reason and passes after it; say so in
the PR, or say why you couldn't show it. One test at the owner covers a bug; don't replay it at
every layer it crossed. A refactor that keeps behaviour must not break a test.

## Junk patterns

Reject these in new tests; in an audit they're candidates (still check the retention bar):

- Assertion-free tests, self-comparisons, `expect(x).toEqual(x)` in disguise, expected values
  computed by the code under test.
- Copied inventories: a test that lists every operation, route, enum value or translation key a
  second time, so it changes with every addition and catches nothing. The matrices aren't this:
  typecheck forces a row, and each row asserts a real refusal.
- Source greps and exact-string checks of code, unless they guard a user-facing key, path or
  byte and survive a rename.
- Call-shape assertions: `toHaveBeenCalledWith` on an internal function, a mocked Prisma, a
  spied helper, where the result the user sees is checkable instead.
- Mocks supplying the behaviour under test, or `vi.mock` of our own modules where a testkit fake
  or the real database would do. External services use `@tuti/testkit` fakes; nothing else is
  mocked without a reason in a comment.
- Duplicate contracts: the same refusal, validation or happy path proved in the db test, the
  REST test, the MCP test and the journey.
- Negative controls that pass for the wrong reason: a "refused" case refused by validation
  before it reaches the guard it names, an "is hidden" check on an element that never existed,
  `not.toBeVisible()` behind an open dialog (AGENTS.md: wait for the dialog's result first).
- Fixtures that fabricate what the owner should produce (an `Activity` row, a sent email, an
  order) instead of running the code that produces it.
- Names promising behaviour the test never exercises. Judge a test by its assertions.

## Retention bar

Keep, even when slow or static:

- the authorization, operations and pages matrices, and every refusal they assert;
- REST, MCP and API-docs contracts (the public API's shape and status codes);
- migrations and `packages/db/src/migrations.test.ts`; storage and persistence;
- security: sign-in, sessions, tokens, private portals, SSO, webhooks' signatures, `Sec-Fetch-Site`;
- billing, credits and plan limits; emails sent (`mailbox`, `latestEmailTo`);
- config (`TUTI_CONFIG`) parsing and defaults; prompts' bytes where a model depends on them;
- observable ordering (lists, activity, retries) and jobs' idempotence;
- journeys of user-facing flows (AGENTS.md); trim their duplicate steps, don't delete the flow.

A test that fails at baseline may be catching a bug: reproduce it and fix the product, don't
delete the test.

## Flaky tests

A flaky test costs a 30–60 minute rerun each time. Fix the cause; never pay its retry tax.

**Banned:** raising a timeout, adding retries, `waitForTimeout` or sleeps, `test.skip`/`fixme`
or deleting the test, mocking real I/O away, weakening an assertion (`toContain` for
`toEqual`, dropping a check). They hide the race; it comes back.

1. **Reproduce first.** Find the failure in CI (`gh run view <id> --log-failed`, the
   `playwright-report-*` artifact's trace). Then make it fail locally on purpose:
   `E2E_CPU_THROTTLE=4 pnpm test:e2e e2e/<file>.spec.ts --repeat-each=20 --workers=3`, or delay
   the event you suspect (a slow route with `page.route`, a delayed job, a fake's latency).
   For Vitest: `pnpm exec vitest run <file> --repeats=50` or `--sequence.shuffle`.
2. **Name the race:** what the test assumed had happened, and what can happen first. Common
   ones here: asserting before a save, a toast, a live stream's update or a navigation lands;
   acting on a list that re-renders; focus or scroll after an animation; a dialog hiding the
   page; journeys sharing data (each makes its own project); time and timezones; ordering
   without an `orderBy`; a fake's state shared across tests in one file.
3. **Fix the cause**, in the app if the race is the product's (a button live before its data,
   a save that can overlap another): users hit those too. In a test, wait on the observable
   result (`expect(locator).toHaveText`, `toHaveURL`, `waitForResponse` on the save), never on
   time.
4. **Prove it:** the reproduction that failed now passes (say how many repeats), and the PR
   names the race.

## Audit and validation

- Before deleting, read the test in full, the code it covers, its callers and the test that
  supposedly covers it instead. Record that remaining proof. No evidence, no deletion; prefer a
  few certain candidates to many guesses. Never chase line counts.
- Delete the production seams a deletion frees, and helpers or fakes nothing uses any more.
- An area mid-migration (docs/plan.md's open items, e.g. "One way in") is about to have its
  tests rewritten: audit it once its item is ticked.
- Run the owner's tests and their siblings (`pnpm test`, `pnpm test:db <files>`,
  `pnpm test:e2e <files>`), `pnpm typecheck` and `pnpm lint`.
- The PR reports: what was removed and why (by category), the contracts kept and their keepers,
  test lines and production lines removed separately, bugs found, follow-ups.
