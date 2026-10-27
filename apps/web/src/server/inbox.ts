"use server";

import { prisma } from "@tuti/db";
import { z } from "zod";

import type { FormState } from "./form-state";
import { OperationError } from "./operations";
import { CONVERSATION_STATUSES, replyToConversation, updateConversation } from "./operations/conversations";
import { asAdmin, asTeam, call } from "./operations/run";
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

export async function replyInConversation(projectSlug: string, conversation: number, body: string): Promise<FormState> {
  return asTeam(projectSlug, "Only the project's team can reply", async (context) =>
    call(replyToConversation, context, { number: conversationNumber(conversation), body: String(body) }),
  );
}

export async function setConversationStatus(projectSlug: string, conversation: number, status: string): Promise<FormState> {
  return asTeam(projectSlug, "Only the project's team can change a conversation's status", async (context) => {
    const parsed = z.enum(CONVERSATION_STATUSES).safeParse(status);
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
