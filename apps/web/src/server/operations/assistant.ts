import { type AnswerLength, prisma } from "@tuti/db";
import { emailConfigured, sendEmail, supportEmailConfirmEmail } from "@tuti/email";
import { log } from "@tuti/shared";
import { headers } from "next/headers";
import { z } from "zod";

import { appUrl } from "@/lib/hosts";
import { hashSecret, randomSecret } from "@/lib/portal-handoff";

import { countEmailedLink } from "../email-link-limits";
import { type Actor, defineOperation, OperationError } from "./define";

/**
 * How the docs' AI answers (Phase 11): a tone, the answer length, standing instructions
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

export type AssistantSettings = {
  tone: string;
  length: AssistantLength;
  instructions: string;
  offLimits: string[];
  /** Where "Ask a person" sends questions (docs.escalate); null is off. */
  supportEmail: string | null;
  /** A new address waiting for its confirmation link to be opened; `supportEmail` keeps working meanwhile. */
  supportEmailPending: string | null;
};

/** A visitor's or a team's address: trimmed, lowercase, valid. */
export const emailAddress = z.string().trim().toLowerCase().max(320, "Enter a valid email address").pipe(z.email("Enter a valid email address"));

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
    select: {
      assistantTone: true,
      assistantLength: true,
      assistantInstructions: true,
      assistantOffLimits: true,
      supportEmail: true,
      supportEmailPending: true,
    },
  });
  return {
    tone: project.assistantTone,
    length: project.assistantLength.toLowerCase() as AssistantLength,
    instructions: project.assistantInstructions,
    offLimits: project.assistantOffLimits,
    supportEmail: project.supportEmail,
    supportEmailPending: project.supportEmailPending,
  };
}

/**
 * The request's headers for the emailed-link limits' per-visitor count. None for an API key:
 * its calls come from the customer's server, which acts for all of its users.
 */
export const limitHeaders = async (actor: Actor) => (actor.kind === "apiKey" ? new Headers() : await headers());

/**
 * Sets the support address: "" turns "Ask a person" off; the confirmed address again drops one
 * waiting; any other (or the waiting one again) gets a new confirmation link, and only becomes
 * the support address once that's opened (confirmSupportEmail). The links count against the
 * emailed-link limits, like sign-in links.
 */
async function setSupportEmail(actor: Actor, projectId: string, address: string) {
  const project = await prisma.project.findUniqueOrThrow({ where: { id: projectId }, select: { name: true, supportEmail: true } });
  if (address === "" || address === project.supportEmail) {
    await prisma.project.update({
      where: { id: projectId },
      data: { ...(address === "" && { supportEmail: null }), supportEmailPending: null, supportEmailTokenHash: null },
    });
    return;
  }
  if (!emailConfigured()) {
    throw new OperationError(503, "email_unavailable", "Email isn't set up on this server");
  }
  const limited = await countEmailedLink(projectId, address, await limitHeaders(actor));
  if ("error" in limited || !limited.id) {
    throw new OperationError(429, "rate_limited", "error" in limited ? limited.error : "You've sent a lot of emails in the last hour. Try again later.");
  }
  const token = randomSecret();
  // A new token replaces the last one, so only the latest link works.
  await prisma.project.update({ where: { id: projectId }, data: { supportEmailPending: address, supportEmailTokenHash: hashSecret(token) } });
  try {
    await sendEmail({
      to: address,
      ...supportEmailConfirmEmail({ projectName: project.name, url: new URL(`/support-email?${new URLSearchParams({ token })}`, appUrl()).toString() }),
    });
  } catch (error) {
    log.error("Sending a support email confirmation failed", { projectId, error });
    throw new OperationError(502, "email_failed", "Couldn't send the confirmation email. Try again.");
  }
}

/** The project and address a support email confirmation link is for, while it's the latest one. */
export async function pendingSupportEmail(token: string) {
  return prisma.project.findUnique({
    where: { supportEmailTokenHash: hashSecret(String(token)) },
    select: { id: true, name: true, supportEmailPending: true },
  });
}

/** Makes the waiting address the support address, if `token` is its latest link. Returns it, or null for a dead link. */
export async function confirmSupportEmailToken(token: string): Promise<{ address: string; projectName: string } | null> {
  const project = await pendingSupportEmail(token);
  if (!project?.supportEmailPending) {
    return null;
  }
  // Only while the link is still the latest: a newer one (or turning it off) changes the hash.
  const { count } = await prisma.project.updateMany({
    where: { id: project.id, supportEmailTokenHash: hashSecret(String(token)), supportEmailPending: project.supportEmailPending },
    data: { supportEmail: project.supportEmailPending, supportEmailPending: null, supportEmailTokenHash: null },
  });
  return count === 1 ? { address: project.supportEmailPending, projectName: project.name } : null;
}

export const getAssistantSettings = defineOperation({
  name: "assistant.get",
  summary:
    "Get how the docs' AI answers: tone, answer length, standing instructions, off-limits topics, and the support email “Ask a person” sends questions to (null when off), with any address waiting for confirmation",
  method: "GET",
  path: "/assistant",
  scope: "read",
  access: "team",
  input: z.object({}),
  run: ({ projectId }) => assistantSettings(projectId),
});

export const updateAssistantSettings = defineOperation({
  name: "assistant.update",
  summary: `Set how the docs' AI answers: tone, answer length (short, medium or detailed), standing instructions, and up to ${MAX_OFF_LIMITS_TOPICS} off-limits topics (replaces the list). A question that names an off-limits topic gets “I can't help with that here” without asking the AI. None of it overrides answering only from the docs. \`supportEmail\` turns on “Ask a person” (docs.escalate): the address gets a confirmation link and takes questions once it's opened (the current one keeps working until then; saving the waiting address again sends a new link); "" turns it off`,
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
    supportEmail: z.string().trim().pipe(z.union([z.literal(""), emailAddress])).optional(),
  }),
  example: {
    tone: "Friendly and plain; address the reader as you",
    length: "short",
    instructions: "Mention the Team page when a question is about inviting people.",
    offLimits: ["refund", "legal advice"],
  },
  run: async ({ actor, projectId }, input) => {
    await prisma.project.update({
      where: { id: projectId },
      data: {
        ...(input.tone !== undefined && { assistantTone: input.tone }),
        ...(input.length !== undefined && { assistantLength: input.length.toUpperCase() as AnswerLength }),
        ...(input.instructions !== undefined && { assistantInstructions: input.instructions }),
        ...(input.offLimits !== undefined && { assistantOffLimits: [...new Set(input.offLimits)] }),
      },
    });
    if (input.supportEmail !== undefined) {
      await setSupportEmail(actor, projectId, input.supportEmail);
    }
    return assistantSettings(projectId);
  },
});
