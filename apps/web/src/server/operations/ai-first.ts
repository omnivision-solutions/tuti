import { prisma } from "@tuti/db";
import { z } from "zod";

import { aiOffReasons } from "../ai-turn";
import { defineOperation } from "./define";

/**
 * "AI answers first", the workflows' built-in step (docs/plan.md, Inbox automation, W14): on or off for the widget's
 * Messages and for email, the name the AI's emailed replies come from, and what keeps it off right now.
 */

export const MAX_AI_NAME = 50;
export const AI_OFF_REASONS = ["no_ai_answers", "no_articles", "out_of_credits"] as const;

export type AiFirstSettings = { widget: boolean; email: boolean; name: string | null; offFor: (typeof AI_OFF_REASONS)[number][] };

/** The project's "AI answers first", as the page and the API read it. */
export async function aiFirstSettings(projectId: string): Promise<AiFirstSettings> {
  const [project, offFor] = await Promise.all([
    prisma.project.findUniqueOrThrow({ where: { id: projectId }, select: { widgetAiFirst: true, emailAiFirst: true, aiName: true } }),
    aiOffReasons(projectId),
  ]);
  return { widget: project.widgetAiFirst, email: project.emailAiFirst, name: project.aiName, offFor };
}

const WIDGET_LINE = "Whether a new message in the widget's Messages goes to the AI first, with “Ask a person” to pass it to the team (true for new projects)";
const EMAIL_LINE = "Whether a new email conversation starts with the AI, which answers from the docs until it goes to a person; only mail whose sender is proven (false for new projects)";
const NAME_LINE = "The name the AI's emailed replies come from, as “<name> at <project>”; null for the project's name alone";

const output = z
  .object({
    widget: z.boolean().describe(WIDGET_LINE).meta({ examples: [true] }),
    email: z.boolean().describe(EMAIL_LINE).meta({ examples: [false] }),
    name: z.string().nullable().describe(NAME_LINE).meta({ examples: ["Ada"] }),
    offFor: z
      .array(z.enum(AI_OFF_REASONS))
      .describe("What keeps the AI from answering right now, whatever the switches say: no_ai_answers (this server has none), no_articles (no published articles), out_of_credits. Empty when it can answer")
      .meta({ examples: [["out_of_credits"]] }),
  })
  .meta({ id: "AiFirstSettings", description: "Where the AI answers before the team, the name its emails come from, and what keeps it off" });

export const getAiFirst = defineOperation({
  name: "aiFirst.get",
  title: "Get AI answers first",
  summary: "Get where the AI answers first (the widget, email), the name its emails come from, and what keeps it from answering right now",
  method: "GET",
  path: "/ai-first",
  scope: "read",
  access: "admin",
  input: z.object({}),
  output: output.describe("AI answers first's settings"),
  run: ({ projectId }) => aiFirstSettings(projectId),
});

export const updateAiFirst = defineOperation({
  name: "aiFirst.update",
  title: "Update AI answers first",
  summary: "Turn AI answers first on or off for the widget and for email, and set the name its emails come from. Fields left out stay as they are",
  method: "PATCH",
  path: "/ai-first",
  scope: "write",
  access: "admin",
  input: z.object({
    widget: z.boolean().optional().describe(WIDGET_LINE).meta({ examples: [true] }),
    email: z.boolean().optional().describe(EMAIL_LINE).meta({ examples: [true] }),
    name: z
      .string()
      .trim()
      .max(MAX_AI_NAME, `Keep the name under ${MAX_AI_NAME} characters`)
      .nullable()
      .optional()
      .describe(`${NAME_LINE}; up to ${MAX_AI_NAME} characters, empty or null to clear it`)
      .meta({ examples: ["Ada"] }),
  }),
  output: output.describe("AI answers first's settings, as saved"),
  example: { email: true, name: "Ada" },
  run: async ({ projectId }, { widget, email, name }) => {
    await prisma.project.update({
      where: { id: projectId },
      data: {
        ...(widget !== undefined && { widgetAiFirst: widget }),
        ...(email !== undefined && { emailAiFirst: email }),
        ...(name !== undefined && { aiName: name || null }),
      },
    });
    return aiFirstSettings(projectId);
  },
});
