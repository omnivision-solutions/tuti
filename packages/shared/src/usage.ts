/**
 * What an AI request used, for the project that caused it (docs/plan.md, AI usage per project):
 * tokens in and out, and what it cost in dollars, when the provider says (OpenRouter does) or the
 * price is known (embeddings). Every request to a model takes a Meter, so none goes unrecorded.
 */
export type AiUsage = {
  kind: "chat" | "decision" | "embedding";
  model: string;
  inputTokens: number;
  outputTokens: number;
  /** In dollars; null when the provider doesn't say (another OpenAI-compatible endpoint). */
  cost: number | null;
};

/** Records an answered request's usage. Never throws (a failure is logged): a recorder can't fail the feature. */
export type Meter = (usage: AiUsage) => Promise<void>;

/** A count from a provider's reply, or 0. */
export const tokens = (value: unknown) => (typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.round(value) : 0);

/** A cost from a provider's reply, or null. */
export const dollars = (value: unknown) => (typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null);
