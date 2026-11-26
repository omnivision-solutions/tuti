import type { AiRole } from "@tuti/shared";

/** A model the AI endpoint lists, with its prices in dollars per token (null when it has none). */
export type ListedModel = { id: string; name: string; input: number | null; output: number | null; tools: boolean };

/**
 * Roughly what one use of each role reads and writes, in tokens, to price it. Autopilot's three are its docs agent's:
 * deciding (rounds of tool calls, each sending the conversation so far), checking (the same, again, only when it
 * proposes a new article) and writing (the edits and drafts, with the same tools, the summary and reasons).
 * ponytail: typical sizes, not this project's own; average its AI usage records if estimates drift.
 */
const TYPICAL_TOKENS: Record<AiRole | "edit_review", { input: number; output: number; per: string }> = {
  answers: { input: 6000, output: 500, per: "answer" },
  escalations: { input: 3000, output: 300, per: "summary" },
  support_draft: { input: 6000, output: 500, per: "reply" },
  support_summary: { input: 3000, output: 300, per: "summary" },
  changelog: { input: 4000, output: 800, per: "draft" },
  code_changes_decide: { input: 150_000, output: 4_000, per: "merged pull request" },
  // Its double-check of a new article; where the server also checks every edit (E5), Autopilot's page prices that apart.
  code_changes_check: { input: 150_000, output: 4_000, per: "double-check of a new article" },
  code_changes: { input: 60_000, output: 5_000, per: "merged pull request" },
  // One Inbox message: the prompt and the message, and its translation.
  translation: { input: 1000, output: 300, per: "message" },
  // Checks' review of one article edit, where the server checks the project's edits (edit-review.ts): about four
  // rounds of tool calls, each sending the pull request, the article before and after it and what the tools read so far.
  edit_review: { input: 70_000, output: 3_000, per: "edit reviewed" },
};

const priced = (model: ListedModel | null | undefined): model is ListedModel & { input: number; output: number } =>
  Boolean(model) && model!.input !== null && model!.output !== null;

/** What one use of `role` (or one edit's review) costs with `model`, in dollars, or null without prices. */
export function costPerUse(role: AiRole | "edit_review", model: ListedModel | undefined): { dollars: number; per: string } | null {
  const typical = TYPICAL_TOKENS[role];
  if (!priced(model)) {
    return null;
  }
  return { dollars: typical.input * model.input + typical.output * model.output, per: typical.per };
}

/** "About $0.0042 per answer", or in credits where AI is paid with them ("About 0.42 credits per answer"). */
export function costLabel(cost: { dollars: number; per: string } | null, creditsPerDollar: number | null): string | null {
  if (!cost) {
    return null;
  }
  const round = (n: number) => Number(n.toPrecision(2));
  if (creditsPerDollar !== null) {
    const credits = round(cost.dollars * creditsPerDollar);
    return `About ${credits} ${credits === 1 ? "credit" : "credits"} per ${cost.per}`;
  }
  return `About $${round(cost.dollars)} per ${cost.per}`;
}
