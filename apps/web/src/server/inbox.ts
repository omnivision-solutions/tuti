"use server";

import { prisma } from "@tuti/db";
import { log } from "@tuti/shared";
import { ses } from "@tuti/shared/ses";
import { emailConfigured, emailDomainTestEmail, sendEmail } from "@tuti/email";
import { sesTenantHeaders } from "@tuti/jobs";
import { z } from "zod";

import { startUpload } from "./attachments";
import type { FormState } from "./form-state";
import { getMembership } from "./membership";
import { OperationError } from "./operations";
import { linkConversationPost, CONVERSATION_STATUSES, replyToConversation, unlinkConversationPost, updateConversation } from "./operations/conversations";
import { asAdmin, asTeam, call } from "./operations/run";
import { getSession } from "./session";
import { supportDomain } from "./inbound";
import { requirePlan } from "./operations/plan";
import { checkEmailDomainOperation, removeEmailDomain, setEmailDomain, updateSupportSettings } from "./operations/support";
import { suggestReply, summarizeConversation } from "./operations/support-ai";

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
  /** Send and close: the reply closes the conversation. */
  close = false,
  /** When the latest message on the page was written: the user writing after it keeps the conversation open. */
  seen?: string,
): Promise<FormState & { notice?: string }> {
  let keptOpen: boolean | undefined;
  const result = await asTeam(projectSlug, "Only the project's team can reply", async (context) => {
    const sent = await call(replyToConversation, context, {
      number: conversationNumber(conversation),
      body: String(body),
      note: note === true,
      ...(Array.isArray(attachments) && attachments.length > 0 && { attachments: attachments.map(String) }),
      ...(close === true && { close: true }),
      ...(typeof seen === "string" && { seen }),
    });
    keptOpen = "keptOpen" in sent && sent.keptOpen === true;
  });
  // A reply that left it open (they wrote again since): said, so nobody moves on thinking it's done or waiting on them.
  return keptOpen ? { ...result, notice: "Sent, and kept open: they wrote again since" } : result;
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
    return await startUpload(membership.project.id, { userId: session.user.id }, parsed.data);
  } catch (error) {
    if (error instanceof OperationError) {
      return { error: error.message };
    }
    throw error;
  }
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

/** Snoozes a conversation till a time to come (ISO), or wakes it (null). */
export async function snoozeConversation(projectSlug: string, conversation: number, until: string | null): Promise<FormState> {
  return asTeam(projectSlug, "Only the project's team can snooze conversations", async (context) =>
    call(updateConversation, context, { number: conversationNumber(conversation), snoozedUntil: until === null ? null : String(until) }),
  );
}

export async function markConversationSpam(projectSlug: string, conversation: number, spam: boolean): Promise<FormState> {
  return asTeam(projectSlug, "Only the project's team can mark spam", async (context) =>
    call(updateConversation, context, { number: conversationNumber(conversation), spam: spam === true }),
  );
}

/**
 * The posts "Link post…" offers for what's typed: the one with that number ("#12" or "12") first, then those with it
 * in their title, the most voted first; with nothing typed, the newest (what someone writes in about is often new).
 * Merged posts are left out. Up to 20.
 */
export async function findPostsToLink(projectSlug: string, q: string): Promise<{ error?: string; posts?: { id: string; number: number; title: string; voteCount: number }[] }> {
  const [session, membership] = await Promise.all([getSession(), getMembership(projectSlug)]);
  if (!session || !membership) {
    return { error: "Only the project's team can link conversations to posts" };
  }
  const projectId = membership.project.id;
  const query = String(q).trim().slice(0, 200);
  const select = { id: true, number: true, title: true, voteCount: true };
  if (!query) {
    return { posts: await prisma.post.findMany({ where: { projectId, duplicateOfId: null }, orderBy: { createdAt: "desc" }, take: 20, select }) };
  }
  // A number as posts have them (a 32-bit integer).
  const asNumber = /^#?\d{1,10}$/.test(query) ? Number(query.replace("#", "")) : null;
  const number = asNumber !== null && asNumber <= 2_147_483_647 ? asNumber : null;
  const [numbered, titled] = await Promise.all([
    number === null ? null : prisma.post.findFirst({ where: { projectId, number, duplicateOfId: null }, select }),
    prisma.post.findMany({
      // Without a leading "#", as the picker matches titles; `contains` is a LIKE: its wildcards (and the escape) typed as themselves.
      where: { projectId, duplicateOfId: null, title: { contains: query.replace(/^#/, "").replace(/[\\%_]/g, "\\$&"), mode: "insensitive" } },
      orderBy: [{ voteCount: "desc" }, { createdAt: "desc" }],
      take: 20,
      select,
    }),
  ]);
  return { posts: [...(numbered ? [numbered] : []), ...titled.filter((post) => post.id !== numbered?.id)].slice(0, 20) };
}

/** Links a conversation to a post it's about (by the post's number), or unlinks it. */
export async function linkPostToConversation(projectSlug: string, conversation: number, post: number, linked: boolean): Promise<FormState> {
  return asTeam(projectSlug, "Only the project's team can link conversations to posts", async (context) => {
    const input = { number: conversationNumber(conversation), post: Number(post) };
    return linked === true ? call(linkConversationPost, context, input) : call(unlinkConversationPost, context, input);
  });
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

const SUPPORT_DENIED = "Only project owners and admins can change support settings";

/** Settings → Support → Your own address (support.setEmailDomain): replies from the team's own address. */
export async function saveEmailDomain(projectSlug: string, _state: FormState, formData: FormData): Promise<FormState> {
  return asAdmin(projectSlug, SUPPORT_DENIED, (context) => call(setEmailDomain, context, { address: String(formData.get("address") ?? "").trim() }));
}

export async function checkEmailDomain(projectSlug: string): Promise<{ error?: string; verified?: boolean }> {
  let verified = false;
  const result = await asAdmin(projectSlug, SUPPORT_DENIED, async (context) => {
    verified = !!(await call(checkEmailDomainOperation, context, {})).email?.ownDomain?.verified;
  });
  return result.error ? result : { verified };
}

export async function forgetEmailDomain(projectSlug: string): Promise<FormState> {
  return asAdmin(projectSlug, SUPPORT_DENIED, (context) => call(removeEmailDomain, context, {}));
}

/** Emails the admin a test from the team's verified address, under the project's tenant, as replies go (only when they do). */
export async function sendEmailDomainTest(projectSlug: string): Promise<FormState> {
  return asAdmin(projectSlug, SUPPORT_DENIED, async ({ actor, projectId }) => {
    const domain = supportDomain();
    if (!ses() || !domain) {
      throw new OperationError(409, "ses_off", "This server doesn't send email from teams' own domains");
    }
    await requirePlan(projectId, "emailDomain");
    const [own, project, user] = await Promise.all([
      prisma.emailDomain.findUnique({ where: { projectId } }),
      prisma.project.findUniqueOrThrow({ where: { id: projectId }, select: { name: true } }),
      actor.kind === "user" ? prisma.user.findUnique({ where: { id: actor.userId }, select: { email: true } }) : null,
    ]);
    if (!own?.verifiedAt) {
      throw new OperationError(409, "not_verified", "Your address isn't verified yet: check it first");
    }
    if (!user) {
      throw new OperationError(400, "no_address", "There's no address to send the test to");
    }
    // Without a mail server, sendEmail only logs it: not a test of anything.
    if (!emailConfigured()) {
      throw new OperationError(409, "email_off", "This server doesn't send email (SMTP_HOST isn't set)");
    }
    try {
      await sendEmail({
        to: user.email,
        from: `"${project.name.replace(/["\\\r\n]/g, "")}" <${own.address}>`,
        headers: (await sesTenantHeaders(projectId, domain, own.domain)) ?? {},
        ...emailDomainTestEmail({ projectName: project.name, address: own.address }),
      });
    } catch (error) {
      log.warn("A test email from a team's own address failed", { projectId, error });
      throw new OperationError(502, "email_failed", `The test email couldn't be sent: ${String(error).slice(0, 200)}`);
    }
  });
}


/**
 * A reply drafted from the docs for the reply box (conversations.suggestReply): the draft, or why there
 * isn't one (the docs don't cover it, the project is out of AI credits, the AI failed).
 */
export async function draftReplyWithAi(
  projectSlug: string,
  conversation: number,
): Promise<{ error: string } | { draft: string } | { draft: null; reason: string }> {
  const [session, membership] = await Promise.all([getSession(), getMembership(projectSlug)]);
  if (!session || !membership) {
    return { error: "Only the project's team can draft replies" };
  }
  try {
    const suggested = await call(suggestReply, { actor: { kind: "user", userId: session.user.id }, projectId: membership.project.id }, { number: conversationNumber(conversation) });
    if (suggested.status === "suggested") {
      return { draft: suggested.draft };
    }
    return {
      draft: null,
      reason:
        suggested.status === "no_answer"
          ? "Your docs don't cover what they asked, so there's no draft"
          : suggested.status === "unavailable"
            ? "This project is out of AI credits"
            : "The AI couldn't draft a reply: try again",
    };
  } catch (error) {
    if (error instanceof OperationError) {
      return { error: error.message };
    }
    throw error;
  }
}

/** Adds the AI's summary of the conversation as a note (conversations.summarize). */
export async function summarizeWithAi(projectSlug: string, conversation: number): Promise<FormState> {
  return asTeam(projectSlug, "Only the project's team can summarize conversations", async (context) =>
    call(summarizeConversation, context, { number: conversationNumber(conversation) }),
  );
}
