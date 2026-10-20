import { type AnswerLength, prisma } from "@tuti/db";
import { z } from "zod";

import { defineOperation } from "./define";

/**
 * How the help center's AI answers (Phase 11): a tone, the answer length, standing instructions
 * and off-limits topics. All of it goes into the answer prompt as the team's settings, apart from
 * the sources; off-limits topics are also checked before the model is asked (`offLimitsTopic`).
 */

export const MAX_ASSISTANT_TONE = 200;
export const MAX_ASSISTANT_INSTRUCTIONS = 2000;
export const MAX_OFF_LIMITS_TOPICS = 20;
export const MAX_OFF_LIMITS_TOPIC = 60;

/** Each length's line in the prompt and its cap on the model's reply (the JSON around the answer included). */
export const ANSWER_LENGTHS = {
  short: { prompt: "Keep it very short: one to three sentences.", maxTokens: 400 },
  medium: { prompt: "Be brief: a short paragraph, or a few list items.", maxTokens: 1000 },
  detailed: { prompt: "Be thorough: cover every step and detail the sections give.", maxTokens: 2000 },
} as const;
export type AssistantLength = keyof typeof ANSWER_LENGTHS;
const LENGTHS = Object.keys(ANSWER_LENGTHS) as [AssistantLength, ...AssistantLength[]];

export type AssistantSettings = { tone: string; length: AssistantLength; instructions: string; offLimits: string[] };

/**
 * Text as off-limits topics are matched: lowercase, accents dropped, and everything but letters
 * and numbers as single spaces, so a match is case-insensitive and on word boundaries.
 */
export const matchText = (text: string) =>
  text
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();

/** The first off-limits topic the question names as whole words, if any ("refund" matches "A refund?", not "refunds"). */
export function offLimitsTopic(question: string, topics: string[]): string | undefined {
  const text = ` ${matchText(question)} `;
  return topics.find((topic) => matchText(topic) !== "" && text.includes(` ${matchText(topic)} `));
}

export async function assistantSettings(projectId: string): Promise<AssistantSettings> {
  const project = await prisma.project.findUniqueOrThrow({
    where: { id: projectId },
    select: { assistantTone: true, assistantLength: true, assistantInstructions: true, assistantOffLimits: true },
  });
  return {
    tone: project.assistantTone,
    length: project.assistantLength.toLowerCase() as AssistantLength,
    instructions: project.assistantInstructions,
    offLimits: project.assistantOffLimits,
  };
}

export const getAssistantSettings = defineOperation({
  name: "assistant.get",
  summary: "Get how the help center's AI answers: tone, answer length, standing instructions and off-limits topics",
  method: "GET",
  path: "/assistant",
  scope: "read",
  access: "team",
  input: z.object({}),
  run: ({ projectId }) => assistantSettings(projectId),
});

export const updateAssistantSettings = defineOperation({
  name: "assistant.update",
  summary: `Set how the help center's AI answers: tone, answer length (short, medium or detailed), standing instructions, and up to ${MAX_OFF_LIMITS_TOPICS} off-limits topics (replaces the list). A question that names an off-limits topic gets “I can't help with that here” without asking the AI. None of it overrides answering only from the help center`,
  method: "PATCH",
  path: "/assistant",
  scope: "write",
  access: "admin",
  input: z.object({
    tone: z.string().trim().max(MAX_ASSISTANT_TONE, `Keep the tone under ${MAX_ASSISTANT_TONE} characters`).optional(),
    length: z.enum(LENGTHS, { error: "Pick short, medium or detailed" }).optional(),
    instructions: z
      .string()
      .trim()
      .max(MAX_ASSISTANT_INSTRUCTIONS, `Keep the instructions under ${MAX_ASSISTANT_INSTRUCTIONS.toLocaleString("en")} characters`)
      .optional(),
    offLimits: z
      .array(
        z
          .string()
          .trim()
          .max(MAX_OFF_LIMITS_TOPIC, `Keep each topic under ${MAX_OFF_LIMITS_TOPIC} characters`)
          .refine((topic) => matchText(topic) !== "", "Each topic needs a word in it"),
      )
      .max(MAX_OFF_LIMITS_TOPICS, `Add up to ${MAX_OFF_LIMITS_TOPICS} topics`)
      .optional(),
  }),
  example: {
    tone: "Friendly and plain; address the reader as you",
    length: "short",
    instructions: "Mention the Team page when a question is about inviting people.",
    offLimits: ["refund", "legal advice"],
  },
  run: async ({ projectId }, input) => {
    await prisma.project.update({
      where: { id: projectId },
      data: {
        ...(input.tone !== undefined && { assistantTone: input.tone }),
        ...(input.length !== undefined && { assistantLength: input.length.toUpperCase() as AnswerLength }),
        ...(input.instructions !== undefined && { assistantInstructions: input.instructions }),
        ...(input.offLimits !== undefined && { assistantOffLimits: [...new Set(input.offLimits)] }),
      },
    });
    return assistantSettings(projectId);
  },
});
