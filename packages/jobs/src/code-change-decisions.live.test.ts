import { decide, decisionModel } from "@tuti/shared";
import { expect, test } from "vitest";

import {
  ARTICLE_QUESTION,
  articleProposal,
  articleState,
  GATE,
  gateResult,
  NEW_ARTICLE_QUESTION,
  newArticleProposal,
  newArticleState,
  POST_QUESTION,
  postProposal,
  postState,
  pullRequestState,
  THRESHOLDS,
} from "./code-change-decisions";
import { article, CASES, post } from "./code-change-eval";

/**
 * The evaluation set against the real decision model (`pnpm test:live`, with OPENROUTER_API_KEY;
 * DECISION_MODEL for another than the default): each kind of decision, with today's thresholds, must match what a team member
 * would expect. Without the keys it's skipped: "not run", never "passed". Prints each decision's
 * probability, to tune the thresholds or compare decision models.
 */
const live = Boolean(process.env.OPENROUTER_API_KEY);

const allowed = <T>(expected: T | T[], actual: T) => (Array.isArray(expected) ? expected.includes(actual) : expected === actual);

test.skipIf(!live)(`code change decisions with ${decisionModel()}`, { timeout: 300_000 }, async () => {
  type Row = { kind: string; name: string; expected: unknown; got: unknown; probability: number; right: boolean };
  const rows: Row[] = [];
  await Promise.all(
    CASES.map(async (c) => {
      const gate = gateResult(await decide(pullRequestState(c.pr), GATE));
      rows.push({ kind: "gate", name: c.name, expected: c.users, got: gate.users >= THRESHOLDS.gate, probability: gate.users, right: c.users === gate.users >= THRESHOLDS.gate });
      const summary = c.summary ?? "";
      const articles = (c.articles ?? []).map((a) => article(a.article));
      await Promise.all([
        ...(c.posts ?? []).map(async (p) => {
          const proposal = postProposal(await decide(postState(c.pr, summary, post(p.post, p.named)), POST_QUESTION));
          rows.push({ kind: "post", name: `${c.name}: ${p.post}`, expected: p.expect, got: proposal?.kind ?? null, probability: proposal?.probability ?? 0, right: allowed(p.expect, proposal?.kind ?? null) });
        }),
        ...(c.articles ?? []).map(async (a) => {
          const proposal = articleProposal(await decide(articleState(c.pr, summary, article(a.article)), ARTICLE_QUESTION));
          const got = proposal ? "ARTICLE_EDIT" : null;
          rows.push({ kind: "article", name: `${c.name}: ${a.article}`, expected: a.expect, got, probability: proposal?.probability ?? 0, right: allowed(a.expect, got) });
        }),
        ...(c.newArticle === undefined
          ? []
          : [
              (async () => {
                const answers = await decide(newArticleState(c.pr, summary, articles), NEW_ARTICLE_QUESTION);
                const probability = (answers.needed as { noul: number }).noul;
                const got = newArticleProposal(answers) !== null;
                rows.push({ kind: "new article", name: c.name, expected: c.newArticle, got, probability, right: allowed(c.newArticle!, got) });
              })(),
            ]),
      ]);
    }),
  );
  rows.sort((a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name));
  console.table(rows.map(({ right, probability, ...row }) => ({ ...row, probability: probability.toFixed(2), right: right ? "✓" : "✗" })));
  const accuracy = Object.fromEntries(
    ["gate", "post", "article", "new article"].map((kind) => {
      const of = rows.filter((row) => row.kind === kind);
      return [kind, of.filter((row) => row.right).length / of.length];
    }),
  );
  console.log(decisionModel(), accuracy);
  for (const [kind, value] of Object.entries(accuracy)) {
    expect({ kind, accuracy: value >= 0.8 }).toEqual({ kind, accuracy: true });
  }
});
