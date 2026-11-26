"use server";

import { prisma } from "@tuti/db";
import { log } from "@tuti/shared";
import { ses } from "@tuti/shared/ses";
import { emailConfigured, emailDomainTestEmail, sendEmail } from "@tuti/email";
import { sesTenantHeaders } from "@tuti/jobs";
import { z } from "zod";

import type { FormState } from "./form-state";
import { getMembership } from "./membership";
import { OperationError } from "./operations";
import {
  CONVERSATION_STATUSES,
  linkConversationPost,
  listArticlesToInsert,
  markConversationRead as markRead,
  replyToConversation,
  retryTranslation as retryTranslationOperation,
  startReplyUpload,
  translateReply,
  unlinkConversationPost,
  updateConversation,
} from "./operations/conversations";
import { ACTIVITY_FILTERS, type Activity, getConversationActivity } from "./operations/conversation-activity";
import { asAdmin, asTeam, call } from "./operations/run";
import { searchPosts } from "./post-lists";
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

/** Viewing a visible, focused conversation acknowledges it for this teammate (never during prefetch). */
export async function markConversationRead(projectSlug: string, conversation: number, seen: string | null): Promise<FormState> {
  return asTeam(projectSlug, "Only the project's team can mark conversations read", (context) =>
    call(markRead, context, { number: conversationNumber(conversation), seen }),
  );
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
  /**
   * Where the conversation is translated: the preview the team saw (previewReplyTranslation), sent as it is; or
   * "untranslated", the team choosing to send it as written ("Send in English"). Neither: translated as it's sent.
   */
  translation?: { text: string; language: string } | "untranslated",
): Promise<FormState & { notice?: string; translation?: "outdated" | "failed"; language?: string }> {
  let keptOpen: boolean | undefined;
  let translationProblem: "outdated" | "failed" | undefined;
  // The customer's language a failed translation was into: its failure is shown for that language only.
  let failedLanguage: string | undefined;
  const result = await asTeam(projectSlug, "Only the project's team can reply", async (context) => {
    try {
      const sent = await call(replyToConversation, context, {
        number: conversationNumber(conversation),
        body: String(body),
        note: note === true,
        ...(Array.isArray(attachments) && attachments.length > 0 && { attachments: attachments.map(String) }),
        ...(close === true && { close: true }),
        ...(typeof seen === "string" && { seen }),
        ...(translation === "untranslated"
          ? { untranslated: true }
          : translation && typeof translation === "object" && { translation: String(translation.text), language: String(translation.language) }),
      });
      keptOpen = "keptOpen" in sent && sent.keptOpen === true;
    } catch (error) {
      // The composer answers these: a new preview (the customer's language changed), or "Send in English".
      if (error instanceof OperationError && (error.code === "translation_outdated" || error.code === "translation_failed")) {
        translationProblem = error.code === "translation_outdated" ? "outdated" : "failed";
        if (translationProblem === "failed") {
          const found = await prisma.conversation.findUnique({
            where: { projectId_number: { projectId: context.projectId, number: conversationNumber(conversation) } },
            select: { language: true },
          });
          failedLanguage = found?.language ?? undefined;
        }
        // Why, without the API's advice (the composer has "Send in English").
        throw new OperationError(error.status, error.code, error.message.replace(/ Send it untranslated.*$/, ""));
      }
      throw error;
    }
  });
  // A reply that left it open (they wrote again since): said, so nobody moves on thinking it's done or waiting on them.
  return { ...result, ...(keptOpen && { notice: "Sent, and kept open: they wrote again since" }), ...(translationProblem && { translation: translationProblem }), ...(failedLanguage && { language: failedLanguage }) };
}

/**
 * A reply as the customer would get it, for the composer's preview (conversations.translateReply): null where it goes
 * as written (translation off, or they write in the team's language).
 */
export async function previewReplyTranslation(
  projectSlug: string,
  conversation: number,
  body: string,
): Promise<{ error: string } | { preview: null } | { preview: { text: string; language: string } } | { failed: string }> {
  const [session, membership] = await Promise.all([getSession(), getMembership(projectSlug)]);
  if (!session || !membership) {
    return { error: "Only the project's team can reply" };
  }
  try {
    const result = await call(translateReply, { actor: { kind: "user", userId: session.user.id }, projectId: membership.project.id }, { number: conversationNumber(conversation), body: String(body) });
    return result.status === "translated" ? { preview: { text: result.text!, language: result.language! } } : result.status === "failed" ? { failed: result.error! } : { preview: null };
  } catch (error) {
    if (error instanceof OperationError) {
      return { error: error.message };
    }
    throw error;
  }
}

/** Try again: the customer's messages whose translation failed, translated again (conversations.retryTranslation). */
export async function retryTranslation(projectSlug: string, conversation: number): Promise<FormState> {
  return asTeam(projectSlug, "Only the project's team can translate messages", async (context) =>
    call(retryTranslationOperation, context, { number: conversationNumber(conversation) }),
  );
}

/** Starts uploading a file for a reply (conversations.upload): where the browser PUTs it, and its id for replyInConversation. */
export async function uploadReplyAttachment(projectSlug: string, file: { filename: string; contentType: string; size: number }): Promise<{ error: string } | { id: string; contentType: string; uploadUrl: string }> {
  const [session, membership] = await Promise.all([getSession(), getMembership(projectSlug)]);
  if (!session || !membership) {
    return { error: "Only the project's team can attach files" };
  }
  try {
    return await call(startReplyUpload, { actor: { kind: "user", userId: session.user.id }, projectId: membership.project.id }, file);
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

/**
 * Take over: a conversation the AI has becomes the team's, with nothing else about it moved (conversations.update's
 * `handledBy`). The app never hands one back: nothing answers for the AI yet (docs/plan.md W6, W12).
 */
export async function takeOverConversation(projectSlug: string, conversation: number): Promise<FormState> {
  return asTeam(projectSlug, "Only the project's team can take over conversations", async (context) =>
    call(updateConversation, context, { number: conversationNumber(conversation), handledBy: "team" }),
  );
}

/** Mark priority, or Remove priority. */
export async function setConversationPriority(projectSlug: string, conversation: number, priority: boolean): Promise<FormState> {
  return asTeam(projectSlug, "Only the project's team can mark conversations priority", async (context) =>
    call(updateConversation, context, { number: conversationNumber(conversation), priority: priority === true }),
  );
}

/**
 * Marks a conversation as spam (with `blockDomain`, its sender's domain too: owners and admins) or not: `notice` is what
 * Not spam leaves in place or undid (conversations.update's), to say with it.
 */
export async function markConversationSpam(projectSlug: string, conversation: number, spam: boolean, blockDomain = false): Promise<FormState & { notice?: string }> {
  let notice: string | undefined;
  const result = await asTeam(projectSlug, "Only the project's team can mark spam", async (context) => {
    const updated = await call(updateConversation, context, {
      number: conversationNumber(conversation),
      spam: spam === true,
      ...(spam === true && blockDomain === true && { blockDomain: true }),
    });
    notice = updated.notice;
  });
  return notice ? { ...result, notice } : result;
}

/** The posts "Link post…" offers for what's typed: any of the project's (searchPosts). */
export async function findPostsToLink(projectSlug: string, q: string): Promise<{ error?: string; posts?: { id: string; number: number; title: string; voteCount: number }[] }> {
  const [session, membership] = await Promise.all([getSession(), getMembership(projectSlug)]);
  if (!session || !membership) {
    return { error: "Only the project's team can link conversations to posts" };
  }
  return { posts: await searchPosts(membership.project.id, q) };
}

/** "Insert article" in a reply (conversations.articles): the articles matching what's typed that the conversation's person can be sent. */
export async function findArticlesToInsert(
  projectSlug: string,
  conversation: number,
  q: string,
): Promise<{ error?: string; articles?: { slug: string; title: string; url: string }[] }> {
  const [session, membership] = await Promise.all([getSession(), getMembership(projectSlug)]);
  if (!session || !membership) {
    return { error: "Only the project's team can insert articles" };
  }
  try {
    return await call(
      listArticlesToInsert,
      { actor: { kind: "user", userId: session.user.id }, projectId: membership.project.id },
      { number: conversationNumber(conversation), q: String(q).trim().slice(0, 200) },
    );
  } catch (error) {
    if (error instanceof OperationError) {
      return { error: error.message };
    }
    throw error;
  }
}

/** The conversation's Activity (conversations.activity): "Show earlier", and its All, Workflows and People filters. */
export async function loadConversationActivity(projectSlug: string, conversation: number, filter: string, before?: string, limit?: number): Promise<{ error?: string; activity?: Activity }> {
  let activity: Activity | undefined;
  const result = await asTeam(projectSlug, "Only the project's team can see a conversation's activity", async (context) => {
    activity = await call(getConversationActivity, context, {
      number: conversationNumber(conversation),
      filter: ACTIVITY_FILTERS.includes(filter as never) ? (filter as (typeof ACTIVITY_FILTERS)[number]) : "all",
      ...(typeof before === "string" && before && { before }),
      ...(Number.isInteger(limit) && { limit: Math.min(Math.max(limit!, 1), 100) }),
    });
  });
  return activity ? { activity } : result;
}

/** Links a conversation to a post it's about (by the post's number), or unlinks it. */
export async function linkPostToConversation(projectSlug: string, conversation: number, post: number, linked: boolean): Promise<FormState> {
  return asTeam(projectSlug, "Only the project's team can link conversations to posts", async (context) => {
    const input = { number: conversationNumber(conversation), post: Number(post) };
    return linked === true ? call(linkConversationPost, context, input) : call(unlinkConversationPost, context, input);
  });
}

/** Settings → Inbox and email: turns the inbox on or off (owners and admins). */
export async function setSupportInbox(projectSlug: string, on: boolean): Promise<FormState> {
  return asAdmin(projectSlug, "Only project owners and admins can change support settings", async (context) =>
    call(updateSupportSettings, context, { inbox: on === true }),
  );
}

/** Settings → Inbox and email: Translate conversations and the team's language (owners and admins; see support.update). */
export async function setTranslation(projectSlug: string, change: { translate?: boolean; teamLanguage?: string }): Promise<FormState> {
  return asAdmin(projectSlug, "Only project owners and admins can change support settings", async (context) =>
    call(updateSupportSettings, context, { translate: change.translate, teamLanguage: change.teamLanguage }),
  );
}

/** Settings → AI → Inbox: the team's instructions for replies drafted by AI (owners and admins; see support.update). */
export async function saveDraftInstructions(projectSlug: string, _state: FormState, formData: FormData): Promise<FormState> {
  return asAdmin(projectSlug, "Only project owners and admins can change support settings", (context) =>
    call(updateSupportSettings, context, {
      // A form sends a textarea's line breaks as CRLF: stored as the box shows and counts them.
      draftInstructions: String(formData.get("instructions") ?? "").replace(/\r\n/g, "\n"),
    }),
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

/** Settings → Inbox and email: gives the project its support email address (owners and admins). */
export async function getSupportAddress(projectSlug: string): Promise<FormState> {
  return asAdmin(projectSlug, "Only project owners and admins can change support settings", async (context) =>
    call(updateSupportSettings, context, { email: true }),
  );
}

const SUPPORT_DENIED = "Only project owners and admins can change support settings";

/** Settings → Inbox and email → Send from your own address (support.setEmailDomain): replies from the team's own address. */
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
 * isn't one (the docs don't cover it, the project is out of credits, the AI failed).
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
            ? "This project is out of credits"
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
