import { type AnswerLength, type Prisma, prisma } from "@tuti/db";
import { headers } from "next/headers";
import { z } from "zod";

import { matchText } from "@/lib/match-text";

import { type Actor, defineOperation, OperationError } from "./define";

/**
 * How the docs' AI answers (Phase 11): the answer length, instructions and off-limits topics. All of it
 * goes into the answer prompt as the team's settings, apart from the sources; off-limits topics are also
 * checked before the model is asked (`offLimitsTopic`).
 *
 * Tone was a setting of its own and is now part of the instructions (docs/plan.md, R4). For one release its
 * column stays, since the previous release still reads and writes it: a stored tone is read folded into the
 * instructions (`foldTone`), and a save writes the instructions and clears it in one update.
 */

export const MAX_ASSISTANT_TONE = 200;
/** Room for the instructions as they were (2,000), a tone and the blank line between them. */
export const MAX_ASSISTANT_INSTRUCTIONS = 2000 + MAX_ASSISTANT_TONE + 2;
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

export type AssistantSettings = {
  /** Always empty: the tone is part of `instructions`. Kept for API clients until the field goes. */
  tone: "";
  length: AssistantLength;
  instructions: string;
  offLimits: string[];
};

/** A visitor's or a team's address: trimmed, lowercase, valid. */
export const emailAddress = z.string().trim().toLowerCase().max(320, "Enter a valid email address").pipe(z.email("Enter a valid email address"));

export { matchText };

/** The first off-limits topic the question names as whole words, if any ("refund" matches "A refund?", not "refunds"). */
export function offLimitsTopic(question: string, topics: string[]): string | undefined {
  const text = ` ${matchText(question)} `;
  return topics.find((topic) => matchText(topic) !== "" && text.includes(` ${matchText(topic)} `));
}

/** The instructions with a tone before them, a blank line between; either alone when the other is empty. */
export const foldTone = (tone: string, instructions: string) =>
  // Instructions that already open with the tone keep it once: the same tone sent twice doesn't stack.
  instructions === tone || instructions.startsWith(`${tone}\n\n`) ? instructions : [tone, instructions].filter(Boolean).join("\n\n");

/** A project's settings as everything reads them (the page, the API, the answer prompt): a stored tone folded into the instructions, saving nothing. */
export async function assistantSettings(projectId: string): Promise<AssistantSettings> {
  const project = await prisma.project.findUniqueOrThrow({
    where: { id: projectId },
    select: {
      assistantTone: true,
      assistantLength: true,
      assistantInstructions: true,
      assistantOffLimits: true,
    },
  });
  return {
    tone: "",
    length: project.assistantLength.toLowerCase() as AssistantLength,
    instructions: foldTone(project.assistantTone, project.assistantInstructions),
    offLimits: project.assistantOffLimits,
  };
}

/**
 * The request's headers for the emailed-link limits' per-visitor count. None for an API key:
 * its calls come from the customer's server, which acts for all of its users.
 */
export const limitHeaders = async (actor: Actor) => (actor.kind === "apiKey" ? new Headers() : await headers());

/** AssistantSettings, as assistant.get and assistant.update return them. */
const settingsOutput = z
  .object({
    tone: z.literal("").describe("Deprecated, and always empty: a tone is part of `instructions`").meta({ examples: [""] }),
    length: z.enum(LENGTHS).describe("How long answers are: `short` (one to three sentences), `medium` (a short paragraph) or `detailed`").meta({ examples: ["medium"] }),
    instructions: z
      .string()
      .describe("Standing instructions for the AI, the tone to write in included")
      .meta({ examples: ["Friendly and plain; address the reader as you."] }),
    offLimits: z
      .array(z.string())
      .describe("Topics the AI doesn't answer: a question that names one gets “I can't help with that here” without asking the AI")
      .meta({ examples: [["refund", "legal advice"]] }),
  })
  .meta({ id: "AssistantSettings", description: "How the docs' AI answers. None of it overrides answering only from the docs" });

export const getAssistantSettings = defineOperation({
  name: "assistant.get",
  title: "Get AI answers' settings",
  summary: "Get how the docs' AI answers: answer length, instructions and off-limits topics",
  method: "GET",
  path: "/assistant",
  scope: "read",
  access: "team",
  input: z.object({}),
  output: settingsOutput.describe("The AI answers' settings"),
  run: ({ projectId }) => assistantSettings(projectId),
});

export const updateAssistantSettings = defineOperation({
  name: "assistant.update",
  title: "Update AI answers' settings",
  summary: "Set how the docs' AI answers: answer length, instructions and off-limits topics. None of it overrides answering only from the docs",
  method: "PATCH",
  path: "/assistant",
  scope: "write",
  access: "admin",
  input: z.object({
    tone: z
      .string()
      .trim()
      .max(MAX_ASSISTANT_TONE, `Keep the tone under ${MAX_ASSISTANT_TONE} characters`)
      .optional()
      .describe(
        "Deprecated, and will be removed: a tone that's sent is put before the instructions (those sent, else those saved), a blank line between, and comes back as part of `instructions`",
      ),
    length: z
      .enum(LENGTHS, { error: "Pick short, medium or detailed" })
      .optional()
      .describe("How long answers are: `short`, `medium` or `detailed`")
      .meta({ examples: ["short"] }),
    instructions: z
      .string()
      .trim()
      .max(MAX_ASSISTANT_INSTRUCTIONS, `Keep the instructions under ${MAX_ASSISTANT_INSTRUCTIONS.toLocaleString("en")} characters`)
      .optional()
      .describe(`Standing instructions for the AI, the tone to write in included, up to ${MAX_ASSISTANT_INSTRUCTIONS.toLocaleString("en")} characters`),
    offLimits: z
      .array(
        z
          .string()
          .trim()
          .max(MAX_OFF_LIMITS_TOPIC, `Keep each topic under ${MAX_OFF_LIMITS_TOPIC} characters`)
          .refine((topic) => matchText(topic) !== "", "Each topic needs a word in it"),
      )
      .max(MAX_OFF_LIMITS_TOPICS, `Add up to ${MAX_OFF_LIMITS_TOPICS} topics`)
      .optional()
      .describe(
        `Up to ${MAX_OFF_LIMITS_TOPICS} topics the AI doesn't answer, each up to ${MAX_OFF_LIMITS_TOPIC} characters; replaces the list. A question that names an off-limits topic (as whole words, in any case) gets “I can't help with that here” without asking the AI`,
      ),
  }),
  output: settingsOutput.describe("The AI answers' settings, as saved"),
  example: {
    length: "short",
    instructions: "Friendly and plain; address the reader as you.\n\nMention the Team page when a question is about inviting people.",
    offLimits: ["refund", "legal advice"],
  },
  run: async ({ projectId }, input) => {
    // Instructions sent are the whole of them (a read gives the stored tone folded in, so written back it adds nothing).
    // A tone sent alone takes the stored tone's place, before the stored instructions.
    // Line breaks as LF, so a tone sent with CRLF is still found at the start of instructions a form saved.
    const lf = (text: string | undefined) => text?.replace(/\r\n/g, "\n");
    const tone = lf(input.tone);
    const save = async (db: Prisma.TransactionClient, sent: string | undefined) => {
      const instructions = tone === undefined ? sent : foldTone(tone, sent ?? "");
      if (instructions !== undefined && instructions.length > MAX_ASSISTANT_INSTRUCTIONS) {
        throw new OperationError(400, "invalid_input", `Keep the instructions under ${MAX_ASSISTANT_INSTRUCTIONS.toLocaleString("en")} characters, the tone included`);
      }
      await db.project.update({
        where: { id: projectId },
        data: {
          ...(input.length !== undefined && { assistantLength: input.length.toUpperCase() as AnswerLength }),
          // With the tone cleared in the same update, so it's never folded in twice.
          ...(instructions !== undefined && { assistantInstructions: instructions, assistantTone: "" }),
          ...(input.offLimits !== undefined && { assistantOffLimits: [...new Set(input.offLimits)] }),
        },
      });
    };
    if (tone !== undefined && input.instructions === undefined) {
      // The project's row is locked for the read, so instructions saved meanwhile aren't overwritten with the ones read here.
      await prisma.$transaction(async (tx) => {
        const [row] = await tx.$queryRaw<{ instructions: string }[]>`
          SELECT "assistantInstructions" AS instructions FROM project WHERE id = ${projectId} FOR NO KEY UPDATE`;
        await save(tx, lf(row?.instructions));
      });
    } else {
      await save(prisma, lf(input.instructions));
    }
    return assistantSettings(projectId);
  },
});
