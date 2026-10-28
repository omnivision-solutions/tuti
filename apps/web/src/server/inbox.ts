"use server";

import { prisma } from "@tuti/db";
import { z } from "zod";

import { startUpload } from "./attachments";
import type { FormState } from "./form-state";
import { getMembership } from "./membership";
import { OperationError } from "./operations";
import { replyToConversation, SETTABLE_STATUSES, updateConversation } from "./operations/conversations";
import { asAdmin, asTeam, call } from "./operations/run";
import { getSession } from "./session";
import { updateSupportSettings } from "./operations/support";

/** The team's actions in the support inbox (any team role), through the conversations operations. */

const number = z.coerce.number().int().positive();

function conversationNumber(value: unknown) {
  const parsed = number.safeParse(value);
  if (!parsed.success) {
    throw new OperationError(400, "invalid_input", "Unknown conversation");
  }
  return parsed.data;
}

export async function replyInConversation(
  projectSlug: string,
  conversation: number,
  body: string,
  note = false,
  /** Files uploaded for it (uploadReplyAttachment), sent with it. */
  attachments: string[] = [],
): Promise<FormState> {
  return asTeam(projectSlug, "Only the project's team can reply", async (context) =>
    call(replyToConversation, context, {
      number: conversationNumber(conversation),
      body: String(body),
      note: note === true,
      ...(Array.isArray(attachments) && attachments.length > 0 && { attachments: attachments.map(String) }),
    }),
  );
}

const uploadSchema = z.object({ filename: z.string().max(1000), contentType: z.string().max(200), size: z.number().int() });

/** Starts uploading a file for a reply: where the browser PUTs it, and its id for replyInConversation. */
export async function uploadReplyAttachment(projectSlug: string, file: { filename: string; contentType: string; size: number }): Promise<{ error: string } | { id: string; contentType: string; uploadUrl: string }> {
  const [session, membership] = await Promise.all([getSession(), getMembership(projectSlug)]);
  const parsed = uploadSchema.safeParse(file);
  if (!session || !membership) {
    return { error: "Only the project's team can attach files" };
  }
  if (!parsed.success) {
    return { error: "That file can't be attached" };
  }
  try {
    return await startUpload(membership.project.id, session.user.id, parsed.data);
  } catch (error) {
    if (error instanceof OperationError) {
      return { error: error.message };
    }
    throw error;
  }
}

export async function setConversationStatus(projectSlug: string, conversation: number, status: string): Promise<FormState> {
  return asTeam(projectSlug, "Only the project's team can change a conversation's status", async (context) => {
    const parsed = z.enum(SETTABLE_STATUSES).safeParse(status);
    if (!parsed.success) {
      throw new OperationError(400, "invalid_input", "Unknown status");
    }
    return call(updateConversation, context, { number: conversationNumber(conversation), status: parsed.data });
  });
}

/** Assigns a conversation to a team member (by their user id), or to nobody (null). */
export async function assignConversation(projectSlug: string, conversation: number, userId: string | null): Promise<FormState> {
  return asTeam(projectSlug, "Only the project's team can assign conversations", async (context) => {
    let assignee: string | null = null;
    if (userId !== null) {
      const member = await prisma.teamMember.findFirst({
        where: { projectId: context.projectId, userId: String(userId) },
        select: { user: { select: { email: true } } },
      });
      if (!member) {
        throw new OperationError(404, "not_found", "That person isn't on the project's team");
      }
      assignee = member.user.email;
    }
    return call(updateConversation, context, { number: conversationNumber(conversation), assignee });
  });
}

export async function markConversationSpam(projectSlug: string, conversation: number, spam: boolean): Promise<FormState> {
  return asTeam(projectSlug, "Only the project's team can mark spam", async (context) =>
    call(updateConversation, context, { number: conversationNumber(conversation), spam: spam === true }),
  );
}

/** Settings → Support: turns the inbox on or off (owners and admins). */
export async function setSupportInbox(projectSlug: string, on: boolean): Promise<FormState> {
  return asAdmin(projectSlug, "Only project owners and admins can change support settings", async (context) =>
    call(updateSupportSettings, context, { inbox: on === true }),
  );
}

/** "Email me new conversations": the signed-in team member's own choice, in the inbox. */
export async function setNewConversationEmails(projectSlug: string, on: boolean): Promise<FormState> {
  return asTeam(projectSlug, "Only the project's team gets the inbox's emails", async ({ actor, projectId }) => {
    if (actor.kind !== "user") {
      return;
    }
    await prisma.teamMember.update({
      where: { projectId_userId: { projectId, userId: actor.userId } },
      data: { emailNewConversations: on === true },
    });
  });
}

/** Settings → Support: gives the project its support email address (owners and admins). */
export async function getSupportAddress(projectSlug: string): Promise<FormState> {
  return asAdmin(projectSlug, "Only project owners and admins can change support settings", async (context) =>
    call(updateSupportSettings, context, { email: true }),
  );
}

