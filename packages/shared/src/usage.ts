/**
 * What an AI request used, for the project that caused it (docs/plan.md, AI usage per project):
 * tokens in and out, and what it cost in dollars, when the provider says (OpenRouter does). Every
 * request to a model takes a Meter, so none goes unrecorded. Embeddings aren't recorded: they cost
 * less than the rows would.
 */
export type AiUsage = {
  kind: "chat" | "decision";
  model: string;
  inputTokens: number;
  outputTokens: number;
  /** In dollars; null when the provider doesn't say (another OpenAI-compatible endpoint). */
  cost: number | null;
};

/** Records an answered request's usage. Never throws (a failure is logged): a recorder can't fail the feature. */
export type Meter = (usage: AiUsage) => Promise<void>;

/** A count from a provider's reply, or null when it gave none. */
export const reportedTokens = (value: unknown) => (typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.round(value) : null);

/** A count from a provider's reply, or 0. */
export const tokens = (value: unknown) => reportedTokens(value) ?? 0;

/** A cost from a provider's reply, or null. */
export const dollars = (value: unknown) => (typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null);

/**
 * What a request really cost, from an OpenRouter reply's usage, or null when it doesn't say. `cost` is
 * what OpenRouter charged; for a call through our own provider key (BYOK) that's only its fee, and the
 * provider's charge is the upstream cost. Other calls report the upstream cost too, already in `cost`.
 */
export const replyCost = (usage: { cost?: unknown; is_byok?: unknown; cost_details?: { upstream_inference_cost?: unknown } | null } | undefined) => {
  const charged = dollars(usage?.cost);
  if (usage?.is_byok !== true) {
    return charged;
  }
  // Without the provider's charge the cost is unknown, not just OpenRouter's fee.
  const upstream = dollars(usage.cost_details?.upstream_inference_cost);
  return upstream === null ? null : (charged ?? 0) + upstream;
};

/** The model that answered, as the reply names it (a router's pick, an alias's build), or the one asked for. */
export const answeredBy = (value: unknown, asked: string) => (typeof value === "string" && value.trim() !== "" ? value.slice(0, 200) : asked);
