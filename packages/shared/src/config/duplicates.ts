import { z } from "zod";

/** The decision model Tuti suggests for duplicates (did best on a small labelled set, 2026-11-20). */
export const DEFAULT_DUPLICATES_MODEL = "typesafe/jev-1.14";

const model = (description: string) =>
  z.strictObject({ model: z.string().regex(/^\S{1,200}$/, "a model id, or off").describe(description).default(DEFAULT_DUPLICATES_MODEL) }).prefault({});

/**
 * Duplicates: embeddings find posts like a new one, and a decision model (OpenRouter's Decisions API) says which of them
 * ask for the same thing. Each a model id, or `off` for embeddings alone (also what a provider without the Decisions API gets).
 */
export const duplicates = z
  .strictObject({
    posted: model("After a post is created: the decision model saying which of the 8 most similar posts it duplicates (they become \"Possible duplicates\"); `off` for similarity alone"),
    typing: model("While a title is typed, on the portal and in the widget: the decision model saying which similar posts to suggest voting on instead; `off` for similarity alone"),
  })
  .prefault({});
