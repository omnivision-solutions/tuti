import { z } from "zod";

import type { AiRole } from "../ai";

const model = (description: string) => z.string().trim().min(1).max(200).nullable().describe(description).default(null);

/** The AI image generator's model without `ai.imageModel` (docs/plan.md, AI image generator). */
export const DEFAULT_IMAGE_MODEL = "google/gemini-nano-banana-2.1";

// The roles by name, not from ../ai: that module reads config(), and importing it here would be a cycle.
const role = () => z.string().trim().min(1).max(200).optional();
const row = z.strictObject({
  answers: role(),
  escalations: role(),
  support_draft: role(),
  support_summary: role(),
  changelog: role(),
  code_changes_decide: role(),
  code_changes_check: role(),
  code_changes: role(),
  translation: role(),
} satisfies Record<AiRole, unknown>);

/**
 * AI's models for every project (a project may pick its own: ai-levels.ts). A feature's model falls back to `model`,
 * then to Tuti's default (for code changes, Autopilot's write model).
 */
export const ai = z
  .strictObject({
    model: model("Every AI feature's model (an OpenRouter model id, or one your endpoint serves), where its own isn't set; Tuti's default without"),
    features: z
      .strictObject({
        answers: model("AI answers' model, instead of `ai.model`"),
        escalations: model("Escalation summaries' model, instead of `ai.model`"),
        support: model("The inbox's drafted replies and summaries' model, instead of `ai.model`"),
        changelog: model("Changelog drafts' model, instead of `ai.model`"),
        codeChanges: model("Autopilot's articles' model, instead of `ai.model` (without either, Autopilot's write model)"),
        translation: model("Translating conversations' model, instead of `ai.model` (without either, openai/gpt-6.1-terra)"),
      })
      .prefault({}),
    imageModel: z
      .string()
      .trim()
      .min(1)
      .max(200)
      .describe(
        "The AI image generator's model, an OpenRouter model that makes images in Gemini's aspect ratios (1:1 to 21:9, 1:8 and 8:1) at 1K, 2K and 4K (image_config). Image generation needs OpenRouter",
      )
      .default(DEFAULT_IMAGE_MODEL),
    maxPrice: z
      .number()
      .positive()
      .nullable()
      .describe("The most a model projects pick may cost, in dollars per million output tokens (a model without a price can't be picked under a cap); no cap without")
      .default(null),
    levels: z
      .strictObject({ affordable: row.optional(), best: row.optional() })
      .nullable()
      .describe(
        "The Affordable and Best levels' models, by role: a level left out isn't offered, a role left out runs on Balanced's (the server's) model. Without, Tuti's own rows, unless a model above is set (then only Balanced and Custom)",
      )
      .default(null),
  })
  .prefault({});

/** The variables this section replaced: setting one stops start-up (checkConfig). */
export const AI_REPLACED = {
  AI_MODEL: "ai.model",
  AI_MODEL_ANSWERS: "ai.features.answers",
  AI_MODEL_ESCALATIONS: "ai.features.escalations",
  AI_MODEL_SUPPORT: "ai.features.support",
  AI_MODEL_CHANGELOG: "ai.features.changelog",
  AI_MODEL_CODE_CHANGES: "ai.features.codeChanges",
  AI_MODEL_MAX_PRICE: "ai.maxPrice",
  AI_LEVELS_CONFIG: "ai.levels",
};
