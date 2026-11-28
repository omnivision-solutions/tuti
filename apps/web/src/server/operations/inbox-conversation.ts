import { type EmailStatus, prisma } from "@tuti/db";
import {
  aiPausedIn,
  automatedRepliesEmailed,
  cappedProjects,
  composerTranslation,
  emailsThisMonth,
  historySince,
  inSomePlansHistory,
  NEW_PROJECT_EMAILS_PER_DAY,
  replyRecipient,
  translationSettings,
  visibleConversations,
} from "@tuti/jobs";
import { aiEnabled, historyDays, plansEnabled } from "@tuti/shared";
import { z } from "zod";

import { formatDay } from "@/lib/format";
import { IMPORT_SOURCES, type ImportSourceKey } from "@/lib/import-parts";
import { isAdminRole } from "@/lib/roles";
import { spamWhy } from "@/lib/spam-reasons";

import { handBackOffered } from "../ai-turn";
import { attachmentLinks } from "../attachments";
import { conversationReads } from "../conversation-reads";
import { anyArticleToSend, readerToSend } from "../docs-search";
import { supportDomain } from "../inbound";
import { postsLikeConversation } from "../post-lists";
import { onlineUntil, presenceKey } from "../presence";
import { spamChoices } from "../spam";
import { activityOutput, conversationActivity } from "./conversation-activity";
import { personPanel, personPanelOutput } from "./conversation-person";
import { assignableTeam, conversationNumber, conversationPerson, MAX_SEARCH_LENGTH, teamMemberId, VIEW_NAMES } from "./conversations";
import { defineOperation, OperationError } from "./define";
import { answersEnabled } from "./docs-ask";
import { projectSlug } from "./read";

/** A conversation shows its latest this many messages, and this many earlier ones with each "Show earlier messages" (`?messages=`). */
const MESSAGES_PER_PAGE = 50;

/** A team message's email, as its page says it (bounces and complaints from Amazon SES's events). */
const EMAIL_STATUS: Record<EmailStatus, (error: string | null) => string> = {
  SENT: () => "Emailed",
  DELIVERED: () => "Emailed and delivered",
  BOUNCED: (error) => `The email bounced${error ? `: ${error}` : ""}`,
  COMPLAINED: () => "They marked the email as spam, so replies aren't emailed to them any more",
  FAILED: (error) => `Couldn't email it${error ? `: ${error}` : ""}`,
};

const date = z.string();
const link = z.object({ label: z.string(), href: z.string() });
const wait = z.object({ status: z.string(), why: z.string(), warning: z.string(), link: link.optional() });

/**
 * One conversation as the Inbox's page shows it (internal, page-shaped): its latest `messages` pages of messages, each
 * with who wrote it and its email's status, its header and triage, what the reply box needs, and what the details beside
 * it start with (the first page of its Activity, posts like it). One past the plan's history: `past`, how to see it again.
 */
export const getInboxConversation = defineOperation({
  name: "inbox.conversation",
  title: "Show a conversation",
  summary: "A conversation as the Inbox shows it: its messages, triage, reply box and details.",
  method: "GET",
  internal: true,
  scope: "read",
  access: "team",
  errors: [404],
  input: z.object({
    number: conversationNumber,
    messages: z.number().int().min(1).default(1),
    /** The Inbox list beside it: its view, or a search's results. Their other conversations in it open beside it there. */
    view: z.enum(VIEW_NAMES).default("open"),
    q: z.string().trim().max(MAX_SEARCH_LENGTH).default(""),
  }),
  output: z.object({
    projectId: z.string(),
    me: z.string(),
    admin: z.boolean(),
    past: z.object({ days: z.number().int(), upgrade: z.boolean() }).nullable(),
    conversation: z
      .object({
        number: z.number().int(),
        subject: z.string(),
        status: z.enum(["OPEN", "WAITING", "CLOSED"]),
        origin: z.enum(["WIDGET", "EMAIL", "ESCALATION", "API"]),
        spam: z.boolean(),
        spamWhy: z.string().nullable(),
        priority: z.boolean(),
        sample: z.boolean(),
        withAi: z.boolean(),
        assigneeId: z.string().nullable(),
        userId: z.string().nullable(),
        email: z.string().nullable(),
        emailVerified: z.boolean(),
        createdAt: date,
        snoozedUntil: date.nullable(),
        canSnooze: z.boolean(),
        person: z.object({ name: z.string().nullable(), email: z.string().nullable(), verified: z.boolean() }),
        personName: z.string(),
        online: date.nullable(),
        unread: z.boolean(),
        answered: z.boolean(),
        canHandBack: z.boolean(),
        messageCount: z.number().int(),
        messages: z.array(
          z.object({
            id: z.string(),
            author: z.enum(["USER", "TEAM", "AI", "TUTI"]),
            authorId: z.string().nullable(),
            name: z.string(),
            status: z.string().nullable(),
            body: z.string(),
            note: z.boolean(),
            original: z.string().nullable(),
            imported: z.string().nullable(),
            attachments: z.array(
              z.object({ id: z.string(), filename: z.string(), contentType: z.string(), size: z.number().int(), image: z.boolean(), url: z.string().nullable() }),
            ),
            attachmentsDropped: z.number().int(),
            teamText: z.string().nullable(),
            language: z.string().nullable(),
            translationError: z.string().nullable(),
            createdAt: date,
          }),
        ),
        team: z.array(z.object({ userId: z.string(), name: z.string(), email: z.string(), image: z.string().nullable() })),
        marking: z.object({ blockSender: z.string().nullable(), blockDomain: z.string().nullable(), unblocks: z.string().nullable(), removesRule: z.string().nullable() }),
        posts: z.array(z.object({ number: z.number().int(), title: z.string(), status: z.string() })),
        related: z.array(z.object({ number: z.number().int(), title: z.string(), status: z.string() })),
        activityCount: z.number().int(),
        activity: activityOutput,
        ai: z.boolean(),
        aiPaused: z.boolean(),
        canRetryTranslation: z.boolean(),
        /** Who it's with, as the panel beside it shows them (personPanel). */
        panel: personPanelOutput,
        reply: z.object({
          emailed: z.boolean(),
          draftWithAi: z.enum(["on", "off", "paused"]),
          articles: z.boolean(),
          wait: wait.nullable(),
          translated: z.object({ language: z.string(), teamLanguage: z.string() }).nullable(),
        }),
      })
      .nullable(),
  }),
  run: async ({ actor, projectId }, input) => {
    const me = teamMemberId(actor);
    const number = input.number;
    const shown = MESSAGES_PER_PAGE * input.messages;
    const [{ role }, project] = await Promise.all([
      prisma.teamMember.findUniqueOrThrow({ where: { projectId_userId: { projectId, userId: me } }, select: { role: true } }),
      prisma.project.findUniqueOrThrow({ where: { id: projectId }, select: { emailPausedAt: true, plan: true } }),
    ]);
    const admin = isAdminRole(role);
    // Replies wait to be emailed while the project's email is paused.
    const emailPaused = plansEnabled() && !!supportDomain() && !!project.emailPausedAt;
    const history = await historySince(projectId);
    const [conversation, team, said] = await Promise.all([
      prisma.conversation.findUnique({
        where: { projectId_number: { projectId, number }, AND: [visibleConversations(history)] },
        select: {
          id: true,
          number: true,
          subject: true,
          status: true,
          origin: true,
          spam: true,
          spamReason: true,
          spamPhrase: true,
          reportedRuleId: true,
          spamMarkedAt: true,
          spamHeldAt: true,
          handledBy: true,
          priority: true,
          sample: true,
          // The customer's language: replies are previewed and sent in it while the project translates (docs/plan.md L22).
          language: true,
          email: true,
          name: true,
          emailVerified: true,
          snoozedUntil: true,
          assigneeId: true,
          userId: true,
          visitorHash: true,
          createdAt: true,
          user: { select: { name: true, email: true, deletedAt: true, ssoIdentity: { select: { externalId: true, email: true } } } },
          posts: { orderBy: { createdAt: "asc" }, select: { post: { select: { number: true, title: true, status: true } } } },
          _count: { select: { messages: true, events: true } },
          // The latest ones, newest first (put in order below).
          messages: {
            orderBy: [{ createdAt: "desc" }, { id: "desc" }],
            take: shown,
            select: {
              id: true,
              author: true,
              authorId: true,
              body: true,
              note: true,
              fromAddress: true,
              original: true,
              seenAt: true,
              import: { select: { source: true } },
              requestId: true,
              emailStatus: true,
              emailError: true,
              createdAt: true,
              authorUser: { select: { name: true } },
              attachments: { orderBy: { createdAt: "asc" }, select: { id: true, key: true, filename: true, contentType: true, size: true } },
              attachmentsDropped: true,
              teamText: true,
              language: true,
              translationError: true,
            },
          },
        },
      }),
      // Who it can be assigned to, as conversations.assignees lists them.
      assignableTeam(projectId),
      // Who wrote last, past the messages shown too (a run of notes can fill them).
      prisma.conversationMessage.findFirst({
        where: { conversation: { projectId, number }, note: false },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        select: { author: true },
      }),
    ]);
    if (!conversation) {
      // Closed before the plan's history starts: kept (for a while), and back with a plan that reaches it.
      const past = history && (await prisma.conversation.findUnique({ where: { projectId_number: { projectId, number } }, select: { activeAt: true, updatedAt: true } }));
      if (!past) {
        throw new OperationError(404, "not_found", "No such conversation");
      }
      return { projectId, me, admin, past: { days: historyDays(project.plan)!, upgrade: inSomePlansHistory(past) }, conversation: null };
    }
    const read = (await conversationReads([conversation.id], me)).get(conversation.id);
    conversation.messages.reverse();
    // Out of credits: the AI's buttons show, disabled (the layout says why). Read only: the layout gives a project its
    // free credits (aiPaused), so a GET doesn't.
    const paused = aiEnabled() && (await aiPausedIn(prisma, projectId));
    const [signed, related, marking] = await Promise.all([
      // Signed as the page renders: an image is shown, any other file is saved under its name.
      attachmentLinks(conversation.messages.flatMap((m) => m.attachments)),
      postsLikeConversation(projectId, conversation),
      // What marking it as spam, or not, would do beyond it: for owners and admins, whose the blocked list is.
      spamChoices(prisma, { ...conversation, projectId }, admin),
    ]);
    const links = new Map(signed.map((a) => [a.id, a]));

    const person = conversationPerson(conversation);
    // Where replies would be emailed at all: they wait while the project's email is paused, and in its
    // first week past its daily cap, until tomorrow, and past its plan's monthly limit, until next month.
    const blocked = person.email
      ? await prisma.emailBlock.findUnique({ where: { projectId_email: { projectId, email: person.email.toLowerCase() } }, select: { email: true } })
      : null;
    // A sample conversation's replies are never emailed (its person's address goes nowhere): nothing waits.
    const emailable = !conversation.spam && !conversation.sample && !!person.email && !blocked;
    const waitsForPause = emailPaused && emailable;
    const month = !emailPaused && emailable ? await emailsThisMonth(projectId) : null;
    // Past what the plan includes, emails a paid plan's credits pay for still go: only those it can't wait.
    const monthFull = month?.held === true;
    // On a license, its emails come with its next month, not the calendar's.
    const licenseMonth = month?.until && formatDay(month.until);
    const capped = !emailPaused && emailable && !monthFull && (await cappedProjects()).includes(projectId);
    const slug = await projectSlug(projectId);
    // Why: in the toast as a reply is sent, and as the title of its held message's short status. Warning: over the reply box, before Send,
    // with where to see more (for owners and admins: nobody else can open Settings).
    const wait = waitsForPause
      ? {
          status: "Not emailed yet",
          why: "Not emailed while your project's email is paused (Settings → Inbox and email)",
          warning: "Your project's email is paused: replies are emailed once it's on again.",
          ...(admin && { link: { label: "Settings", href: `/app/${slug}/settings/support` } }),
        }
      : monthFull && month?.perEmail != null
        ? // Past the included ones, credits pay for more (claimProjectEmail): it's credits that are missing, and buying them sends it now.
          // Only owners and admins can buy them (Billing is theirs): everyone else is told who can.
          admin
          ? {
              status: `Emailed ${licenseMonth ?? "next month"}`,
              why: `Emailed ${licenseMonth ?? "next month"} unless you buy credits: this month's included emails are used and not enough credits are left (Settings → Billing)`,
              warning: `This month's included emails are used and not enough credits are left: buy credits to email replies now, or they go ${licenseMonth ? `on ${licenseMonth}` : "next month"}.`,
              link: { label: "Billing", href: `/app/${slug}/settings/billing` },
            }
          : {
              status: `Emailed ${licenseMonth ?? "next month"}`,
              why: `Emailed ${licenseMonth ?? "next month"} unless an owner or admin buys credits: this month's included emails are used and not enough credits are left`,
              warning: `This month's included emails are used and not enough credits are left: replies are emailed ${licenseMonth ? `on ${licenseMonth}` : "next month"} unless an owner or admin buys credits.`,
            }
        : monthFull && licenseMonth
          ? {
              status: `Emailed ${licenseMonth}`,
              why: `Emailed ${licenseMonth}: your license's emails for this month are used (Settings → Billing)`,
              warning: `This month's emails from your license are used: replies are emailed on ${licenseMonth}.`,
              ...(admin && { link: { label: "Billing", href: `/app/${slug}/settings/billing` } }),
            }
          : monthFull
            ? {
                status: "Emailed next month",
                why: "Emailed next month: your plan's emails for this month are used (Settings → Billing)",
                warning: "This month's emails are used: replies are emailed next month.",
                ...(admin && { link: { label: "Billing", href: `/app/${slug}/settings/billing` } }),
              }
            : capped
              ? {
                  status: "Emailed tomorrow",
                  why: `Emailed tomorrow: in its first week, a project sends up to ${NEW_PROJECT_EMAILS_PER_DAY} emails a day`,
                  warning: `Today's emails are used (a project's first week sends up to ${NEW_PROJECT_EMAILS_PER_DAY} a day): replies are emailed tomorrow.`,
                }
              : null;
    const online =
      conversation.userId || conversation.visitorHash ? await onlineUntil(projectId, presenceKey({ userId: conversation.userId, visitorHash: conversation.visitorHash })) : null;
    const personName = person.name ?? person.email ?? "Unknown";
    const withAi = conversation.handledBy === "AI";
    const canSnooze = !conversation.spam && conversation.status !== "CLOSED";
    // Replies go out in the customer's language, previewed under the composer (docs/plan.md L22).
    const translation = await translationSettings(projectId);
    type Message = (typeof conversation.messages)[number];
    // Someone else on the email (in Cc) shows as their address.
    const byName = (message: Message) => (message.author === "USER" ? (message.fromAddress ?? personName) : (message.authorUser?.name ?? (message.author === "AI" ? "AI" : "Tuti")));
    // The tool an imported message came from, by name.
    const importedFrom = (message: Message) => (message.import ? IMPORT_SOURCES[message.import.source.toLowerCase() as ImportSourceKey].name : null);
    // A team reply's email, under it. Imported history was never emailed: no email status for it (docs/plan.md, Switching
    // from Featurebase), but the tool it came from.
    // A workflow's set reply (the AI's, with a requestId) is emailed only where the address is proven (packages/jobs).
    const automated = (message: Message) => message.author === "AI" && !!message.requestId;
    const emailed = (message: Message) =>
      !(message.author === "TEAM" || automated(message)) || message.note
        ? null
        : automated(message) && !message.seenAt && !message.emailStatus && !automatedRepliesEmailed(conversation)
          ? "Not emailed: their address isn't verified"
          : message.seenAt
            ? "Seen"
            : message.import
              ? `Imported from ${importedFrom(message)}`
              : message.emailStatus
                ? EMAIL_STATUS[message.emailStatus](message.emailError)
                : (wait?.status ?? null);
    // Not for widget conversations: they're emailed only if unseen there for a minute, too fiddly to say here.
    const repliesEmailed = !withAi && !conversation.userId && !conversation.visitorHash && !waitsForPause && "to" in (await replyRecipient(conversation.id));
    return {
      projectId,
      me,
      admin,
      past: null,
      conversation: {
        number: conversation.number,
        subject: conversation.subject,
        status: conversation.status,
        origin: conversation.origin,
        spam: conversation.spam,
        // Why the filter filed it; else a teammate marked it (one from before the two were told apart says neither).
        // Still held for the AI check (W4): in no view yet, but a link can reach it.
        spamWhy:
          conversation.spamHeldAt && !conversation.spamMarkedAt
            ? "the spam filter is still checking it"
            : (spamWhy(conversation.spamReason, conversation.spamPhrase) ?? (conversation.spamMarkedAt ? "a teammate marked it" : null)),
        priority: conversation.priority,
        sample: conversation.sample,
        withAi,
        assigneeId: conversation.assigneeId,
        userId: conversation.userId,
        email: conversation.email,
        emailVerified: conversation.emailVerified,
        createdAt: conversation.createdAt,
        snoozedUntil: canSnooze && conversation.snoozedUntil && conversation.snoozedUntil > new Date() ? conversation.snoozedUntil : null,
        canSnooze,
        person: { name: person.name, email: person.email, verified: person.verified },
        personName,
        online,
        unread: read?.unread ?? false,
        // Waiting is the team having replied last: replying sets it; by hand, only once their reply is the latest.
        answered: said?.author === "TEAM",
        // Hand back to the AI: only on the team's, never while its user waits on the team (their message would go
        // unanswered), and only where the AI would answer their next one.
        canHandBack: await handBackOffered(projectId, conversation),
        messageCount: conversation._count.messages,
        messages: conversation.messages.map((message) => ({
          id: message.id,
          author: message.author,
          authorId: message.authorId,
          name: byName(message),
          status: emailed(message),
          body: message.body,
          note: message.note,
          original: message.original,
          imported: importedFrom(message),
          attachments: message.attachments.map((a) => links.get(a.id)!),
          attachmentsDropped: message.attachmentsDropped,
          teamText: message.teamText,
          language: message.language,
          translationError: message.translationError,
          createdAt: message.createdAt,
        })),
        team: team.map((m) => ({ userId: m.userId, name: m.user.name, email: m.user.email, image: m.user.image })),
        marking,
        posts: conversation.posts.map((linked) => linked.post),
        related: related.map((p) => ({ number: p.number, title: p.title, status: p.status })),
        activityCount: conversation._count.events,
        activity: await conversationActivity(conversation.id),
        ai: aiEnabled(),
        aiPaused: paused,
        // Try again runs only where it can: translation on, and AI on the server.
        canRetryTranslation: translation.translate && aiEnabled(),
        // Read with the rest, so the panel is of the conversation the page shows.
        panel: await personPanel(projectId, { ...conversation, name: person.name }, { besides: number, inbox: { userId: me, view: input.view, q: input.q } }),
        reply: {
          emailed: repliesEmailed,
          draftWithAi: answersEnabled() ? (paused ? ("paused" as const) : ("on" as const)) : ("off" as const),
          // "Insert article": once there's an article they can be sent (what its search finds).
          articles: !withAi && (await anyArticleToSend(projectId, await readerToSend(projectId, conversation.userId))),
          wait,
          // Without AI on the server, nothing is translated: no preview, and replies go as written (as the server sends them).
          translated: composerTranslation(translation, conversation.language, aiEnabled()) ?? null,
        },
      },
    };
  },
});
