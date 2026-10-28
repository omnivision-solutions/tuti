/** How Settings → Usage and AI models write features and amounts. */

/** Each AI feature's name. */
export const AI_FEATURE_NAMES: Record<string, string> = {
  answers: "AI answers",
  escalations: "Ask a person (summaries)",
  support: "Support inbox (drafts and summaries)",
  changelog: "Changelog drafts and edits",
  code_changes: "Code changes",
};

/** Dollars: cents, or four places below a cent, or "under $0.0001" for a sliver. */
export const money = (dollars: number) =>
  dollars > 0 && dollars < 0.0001 ? "under $0.0001" : `$${dollars > 0 && dollars < 0.01 ? dollars.toFixed(4) : dollars.toFixed(2)}`;
export const count = (n: number) => n.toLocaleString("en");

/** A feature's cost: "No price" when the provider priced none of its requests (it isn't free), else what's known. */
export const costOf = (feature: { requests: number; cost: number; unpriced: number }) =>
  feature.unpriced === feature.requests ? "No price" : money(feature.cost);

/** AI credits: whole ones from 100 up, else up to two places, or "under 0.01" for a sliver. */
export const credits = (n: number) =>
  n > 0 && n < 0.01 ? "under 0.01" : n.toLocaleString("en", { maximumFractionDigits: Math.abs(n) >= 100 ? 0 : 2 });
