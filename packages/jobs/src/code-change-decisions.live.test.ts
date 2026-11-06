import { decide, type DecisionAnswer, decisionModel, decisionsAvailable } from "@tuti/shared";
import { expect, test } from "vitest";

import { GATE, gateResult, POST_QUESTION, postProposal, postState, pullRequestState, thresholds } from "./code-change-decisions";
import { CASES, post } from "./code-change-eval";

/**
 * The evaluation set against the real decision model (`pnpm test:live`, with OPENAI_API_KEY, an OpenRouter key;
 * CODE_CHANGES_DECISIONS_MODEL for another than the default): each kind of decision it makes (the gate and the posts;
 * the help center's are the docs agent's, code-change-docs-agent.live.test.ts), with today's thresholds, must match what
 * a team member would expect. Without the keys it's skipped: "not run", never "passed". Prints the model's answers
 * for each decision (proposed or not), to tune the thresholds or compare decision models.
 */
// It asks the decision model, so only where the Decisions API is (OpenRouter): skipped anywhere else.
const live = decisionsAvailable();

/** The evaluation's spend isn't a project's. */
const meter = async () => {};

const allowed = <T>(expected: T | T[], actual: T) => (Array.isArray(expected) ? expected.includes(actual) : expected === actual);

/** The model's answers as they came, whatever the thresholds made of them: "resolves 0.62, related 0.30" (the likeliest first), or a yes/no's probability. */
const odds = (answers: Record<string, DecisionAnswer>) =>
  Object.values(answers)
    .map((answer) =>
      answer.type === "noul"
        ? answer.noul.toFixed(2)
        : Object.entries(answer.probabilities)
            .sort((a, b) => b[1] - a[1])
            .filter(([, p]) => p >= 0.01)
            .map(([option, p]) => `${option} ${p.toFixed(2)}`)
            .join(", "),
    )
    .join("; ");

test.skipIf(!live)(`code change decisions with ${decisionModel()}`, { timeout: 300_000 }, async () => {
  type Row = { kind: string; name: string; expected: unknown; got: unknown; answers: string; right: boolean };
  const rows: Row[] = [];
  await Promise.all(
    CASES.map(async (c) => {
      const gateAnswers = await decide(pullRequestState(c.pr), GATE, { meter });
      const gate = gateResult(gateAnswers);
      rows.push({ kind: "gate", name: c.name, expected: c.users, got: gate.users >= thresholds().gate, answers: odds(gateAnswers), right: c.users === gate.users >= thresholds().gate });
      const summary = c.summary ?? "";
      await Promise.all(
        (c.posts ?? []).map(async (p) => {
          const answers = await decide(postState(c.pr, summary, post(p.post, p.named)), POST_QUESTION, { meter });
          const proposal = postProposal(answers);
          rows.push({ kind: "post", name: `${c.name}: ${p.post}`, expected: p.expect, got: proposal?.kind ?? null, answers: odds(answers), right: allowed(p.expect, proposal?.kind ?? null) });
        }),
      );
    }),
  );
  rows.sort((a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name));
  console.table(rows.map(({ right, ...row }) => ({ ...row, right: right ? "✓" : "✗" })));
  const accuracy = Object.fromEntries(
    ["gate", "post"].map((kind) => {
      const of = rows.filter((row) => row.kind === kind);
      return [kind, of.filter((row) => row.right).length / of.length];
    }),
  );
  console.log(decisionModel(), accuracy);
  for (const [kind, value] of Object.entries(accuracy)) {
    expect({ kind, accuracy: value >= 0.8 }).toEqual({ kind, accuracy: true });
  }
});
