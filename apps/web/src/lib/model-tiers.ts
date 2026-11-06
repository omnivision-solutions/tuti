/** A model the AI endpoint lists, with its prices in dollars per token (null when it has none). */
export type ListedModel = { id: string; name: string; input: number | null; output: number | null; tools: boolean };

export type Tier = "fast" | "balanced" | "best";
/** What a row's choice is: a tier, a custom id, or (Autopilot's double-check) off. */
export type Choice = Tier | "custom" | "off";
export const TIER_NAMES: Record<Tier, string> = { fast: "Fast", balanced: "Balanced", best: "Best" };

/** Balanced and Best: offered where the endpoint lists them. Fast is each feature's default on the server. */
const TIER_MODELS: Record<Exclude<Tier, "fast">, string> = {
  balanced: "anthropic/claude-sonnet-5.5",
  best: "anthropic/claude-opus-5.5",
};

/**
 * Roughly what one use of each feature reads and writes, in tokens, to price it. Autopilot's three steps are its docs
 * agent's: deciding (rounds of tool calls, each sending the conversation so far), the double-check (the same, again,
 * only when it proposes a new article) and writing (the edits and drafts, with the same tools, the summary and reasons).
 * ponytail: typical sizes, not this project's own; average its AI usage records if estimates drift.
 */
const TYPICAL_TOKENS: Record<string, { input: number; output: number; per: string }> = {
  answers: { input: 6000, output: 500, per: "answer" },
  escalations: { input: 3000, output: 300, per: "summary" },
  support: { input: 6000, output: 500, per: "reply" },
  changelog: { input: 4000, output: 800, per: "draft" },
  code_changes_decide: { input: 150_000, output: 4_000, per: "merged pull request" },
  code_changes_redecide: { input: 150_000, output: 4_000, per: "double-check (only when it proposes a new article)" },
  code_changes: { input: 60_000, output: 5_000, per: "merged pull request" },
};

const priced = (model: ListedModel | null | undefined): model is ListedModel & { input: number; output: number } =>
  Boolean(model) && model!.input !== null && model!.output !== null;

/** What one use of `feature` (or Autopilot step) costs with `model`, in dollars, or null without prices. */
export function costPerUse(feature: string, model: ListedModel | undefined): { dollars: number; per: string } | null {
  const typical = TYPICAL_TOKENS[feature];
  if (!typical || !priced(model)) {
    return null;
  }
  return { dollars: typical.input * model.input + typical.output * model.output, per: typical.per };
}

/** The tiers a feature offers: Fast (its default), then Balanced and Best where listed, each with its model. */
export function tiersFor(defaultModel: string, listed: ListedModel[]): { tier: Tier; model: string }[] {
  const ids = new Set(listed.map((model) => model.id));
  return [
    { tier: "fast" as const, model: defaultModel },
    ...(Object.entries(TIER_MODELS) as [Tier, string][])
      .filter(([, model]) => ids.has(model) && model !== defaultModel)
      .map(([tier, model]) => ({ tier, model })),
  ];
}

/** Which choice a saved pick is: no pick is Fast, "off" Off, a tier's model that tier, anything else Custom. */
export function choiceOf(picked: string | null, tiers: { tier: Tier; model: string }[]): Choice {
  if (picked === null) {
    return "fast";
  }
  if (picked === "off") {
    return "off";
  }
  return tiers.find((option) => option.tier !== "fast" && option.model === picked)?.tier ?? "custom";
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

/**
 * The model id a feature's choice saves: "" for Fast (the default), "off", the tier's model, or the custom id.
 * A tier no longer offered (the endpoint stopped listing its model) keeps what was saved, as a custom id.
 */
export function pickedModel(choice: Choice, custom: string, tiers: { tier: Tier; model: string }[], saved: string | null): string {
  if (choice === "fast") {
    return "";
  }
  if (choice === "off") {
    return "off";
  }
  if (choice === "custom") {
    return custom;
  }
  return tiers.find((option) => option.tier === choice)?.model ?? saved ?? "";
}
