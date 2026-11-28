# Test cleanup campaign

A campaign prunes one area's whole test surface, one PR per area: a package
(`packages/jobs`), the worker, the mobile app, or one product area of the web app (the Inbox:
its operations' db tests, its components' unit tests, its journeys). [SKILL.md](SKILL.md)'s
gate, junk patterns, retention bar and validation apply throughout; this file is the order of
work. Each step ends on its done line; don't start the next one early.

## 1. Baseline

Pin a `main` SHA. Record the area's test and test-support line counts (`*.test.ts`,
`*.db.test.ts`, `e2e/*.spec.ts`, helpers and fakes it alone uses) and each test file's result
at that SHA (`pnpm test`, `pnpm test:db <files>`, `pnpm test:e2e <its journeys>`). Keep
failures in their own list: they may be product bugs (step 7), not stale tests. Note any file
CI has seen flake (SKILL.md, Flaky tests).

Done when every test file in the area has a recorded result.

## 2. Lanes

Split the area along its production owners, not file names: each operation group
(`apps/web/src/server/operations/<area>`), its server actions and pages, its components, its
jobs (`packages/jobs`), its REST and MCP routes, its journeys. Include the area's rows in the
shared matrices (read-only: see step 5) and its cases in shared suites (API docs, routes).

Done when every test file and journey the area owns sits in exactly one lane.

## 3. Ledger per lane

A read-only agent per lane reads every test in full (parameter tables too), plus the code it
covers, that code's callers, the file's history (`git log -p`) and how CI runs it. Each test
declaration gets one mark and one line of evidence; an `it.each` is one declaration unless its
rows need different marks.

- **R** retain: the contract and the bug it catches.
- **F** fix: keep the contract, repair the assertion (a vacuous negative, a `toContain` that
  passes when one of several items is missing, a check behind an open dialog).
- **C** consolidate: name the keeper that absorbs it (a row in a sibling table, a stronger
  boundary's test, a journey step).
- **D** delete: name the proof that remains, or why no contract exists.

Judge by assertions, not names. The ledger lives outside the repo (it's working notes); its
summary goes in the PR.

Done when every declaration has a mark and evidence.

## 4. Layer plan

A second read-only pass, starting from the ledger, looks for whole redundant layers: an
operation's behaviour proved again through its server action, its REST route, its MCP tool
and its journey; a component's unit test replaying what its journey shows. Name the **keeper**
per contract, preferring the real boundary (the db test calling the operation, a testkit fake
for the outside service) over a mocked collaborator. Before calling a test redundant, read the
keeper: it must assert the same thing, not just touch the same code. Fix ledger errors found.

Done when each lane names the files it retires, the keeper per contract, the assertions to
carry into keepers, and the test-only seams it frees.

## 5. Cutover

Edit lane by lane. Shared helpers (`apps/web/src/test/helpers.ts`, `e2e/helpers.ts`,
`@tuti/testkit`) change through one lane at a time. With each lane, delete the production seams
it frees (test-only exports, injection parameters, reset functions) and support files nothing
uses any more. A journey keeps its flow and its `checkpoints()`; trim repeated steps another
journey already owns. New data uses `e2e-…@example.com` emails.

The matrices (`authorization.db.test.ts`, `operations.db.test.ts`, `operations/index.ts`) take
rows from every feature PR. Don't restructure them in an area's PR; a change to their shape is
its own PR, agreed with whoever has migration PRs open against them.

Done when every lane's plan is applied and the keepers pass.

## 6. Preservation review

Before calling it done, independent reviewers (one per lane group, given the deleted tests and
the keepers, not the ledger's conclusions) look for contracts that lost their only proof, and
for new assertions that can't fail. For each contract restored, make one deliberate mutation of
the production code, watch the keeper go red, then restore the code byte for byte.

Done when every gap is restored or rejected with evidence, and each restored contract has a
caught mutation.

## 7. Product bugs

A baseline failure that survives into a keeper is a bug. Fix it in the product, in its own
commit (or its own PR if it's large), with the test failing before and passing after on the
same run. Unrelated bugs found along the way become issues.

Done when each fixed bug has a failing control and a passing candidate.

## 8. Reconcile and hand off

Merge `main` before pushing. If `main` changed a test this PR deletes, keep the deletion and
move `main`'s new assertion into the keeper. Rerun only what the merge touched or CI failed.

The PR description (Why, What changed, How tested) adds:

- test and support lines before and after, production lines separately;
- lanes, retired layers and keepers;
- gaps the preservation review found and the mutations that proved them;
- bugs fixed, with their control runs; follow-up issues.
