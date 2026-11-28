import { type Prisma, prisma } from "@tuti/db";
import { historySince, pastConversations, visibleConversations } from "@tuti/jobs";
import { z } from "zod";

import { rowBy, rowLine } from "@/lib/format";
import { isAdminRole } from "@/lib/roles";

import { conversationReads } from "../conversation-reads";
import { conversationCompanies } from "../inbox-companies";
import { inboxStats } from "../inbox-stats";
import {
  conversationPerson,
  conversationsMatching,
  latestMessages,
  matchedMessages,
  MAX_SEARCH_LENGTH,
  teamMemberId,
  toApiStatus,
  VIEW_NAMES,
  viewCounts,
  viewWhere,
} from "./conversations";
import { defineOperation } from "./define";

/** The list shows this many conversations, and this many more with each "Load more" (`?page=`). */
const INBOX_PER_PAGE = 100;

const LISTED = {
  number: true,
  subject: true,
  status: true,
  email: true,
  name: true,
  emailVerified: true,
  lastMessageAt: true,
  waitingSince: true,
  snoozedUntil: true,
  handledBy: true,
  priority: true,
  sample: true,
  id: true,
  assignee: { select: { name: true, image: true } },
  userId: true,
  user: { select: { name: true, email: true, emailVerified: true, image: true, deletedAt: true, ssoIdentity: { select: { externalId: true, email: true, properties: true } } } },
} as const;

const date = z.string();

/**
 * The Inbox's list pane, as the app shows it (internal, page-shaped): its views' counts, the first `pages` pages of a
 * view's conversations or a search's (`q`: every view but Spam), each row with what it says, and the pane's notes.
 * `overview`: with the Inbox's numbers too, for the pane beside the list while no conversation is open.
 */
export const getInboxList = defineOperation({
  name: "inbox.list",
  title: "Show the Inbox's list",
  summary: "The Inbox's list pane: its views' counts, a view's or a search's conversations, and the notes above them.",
  method: "GET",
  internal: true,
  scope: "read",
  access: "team",
  input: z.object({
    view: z.enum(VIEW_NAMES).default("open"),
    q: z.string().trim().max(MAX_SEARCH_LENGTH).default(""),
    pages: z.number().int().min(1).default(1),
    overview: z.boolean().default(false),
  }),
  output: z.object({
    counts: z.array(z.number().int()),
    total: z.number().int(),
    hidden: z.number().int(),
    conversations: z.array(
      z.object({
        number: z.number().int(),
        subject: z.string(),
        status: z.enum(["open", "waiting", "closed"]),
        handledBy: z.enum(["team", "ai"]),
        priority: z.boolean(),
        sample: z.boolean(),
        lastMessageAt: date,
        waitingSince: date.nullable(),
        snoozedUntil: date.nullable(),
        name: z.string(),
        image: z.string().nullable(),
        company: z.string().nullable(),
        unread: z.boolean(),
        assignee: z.object({ name: z.string(), image: z.string().nullable() }).nullable(),
        line: z.string().nullable(),
        match: z.object({ note: z.boolean(), snippet: z.string() }).nullable(),
      }),
    ),
    projectName: z.string(),
    admin: z.boolean(),
    supportInbox: z.boolean(),
    plan: z.string().nullable(),
    emailNewConversations: z.boolean(),
    stats: z.object({ waiting: z.number().int(), oldest: date.nullable(), replyMs: z.number().nullable(), newThisWeek: z.number().int() }).nullable(),
  }),
  run: async ({ actor, projectId }, { view, q, pages, overview }) => {
    const me = teamMemberId(actor);
    const history = await historySince(projectId);
    // A search's results: every status, never spam nor what's past the plan's history.
    const matching = q ? await conversationsMatching(projectId, q) : null;
    const where: Prisma.ConversationWhereInput = matching ? { projectId, spam: false, AND: [visibleConversations(history), matching] } : viewWhere(view, projectId, me, history);
    const [counts, rows, member, project, stats] = await Promise.all([
      viewCounts(projectId, me, history),
      prisma.conversation.findMany({ where, orderBy: [{ lastMessageAt: "desc" }, { number: "desc" }], take: INBOX_PER_PAGE * pages, select: LISTED }),
      prisma.teamMember.findUniqueOrThrow({ where: { projectId_userId: { projectId, userId: me } }, select: { emailNewConversations: true, role: true } }),
      prisma.project.findUniqueOrThrow({ where: { id: projectId }, select: { name: true, supportInbox: true, plan: true } }),
      overview ? inboxStats(projectId) : null,
    ]);
    // Closed, Spam and a search: how many are past the plan's history (said above the list, rather than an empty one alone).
    const hidden = !history
      ? 0
      : matching
        ? await prisma.conversation.count({ where: { projectId, spam: false, AND: [pastConversations(history), matching] } })
        : view === "closed" || view === "spam"
          ? await prisma.conversation.count({ where: { AND: [viewWhere(view, projectId, me), pastConversations(history)] } })
          : 0;
    const ids = rows.map((c) => c.id);
    const latest = await latestMessages(ids);
    const companies = await conversationCompanies(projectId, rows);
    const reads = await conversationReads(ids, me);
    const matches = q ? await matchedMessages(ids, q) : null;
    // How many the list has in all: the view's count, or the search's.
    const total = q ? await prisma.conversation.count({ where }) : counts[VIEW_NAMES.indexOf(view)]!;
    return {
      counts,
      total,
      hidden,
      conversations: rows.map((c) => {
        const person = conversationPerson(c);
        // The latest message's first line, with who wrote it when it isn't the person (an AI answer isn't their question).
        const message = latest.get(c.id);
        const text = message && rowLine(c.subject, message.body);
        const by = message && rowBy(message, me);
        const match = matches?.get(c.id);
        return {
          number: c.number,
          subject: c.subject,
          status: toApiStatus(c.status),
          handledBy: c.handledBy === "AI" ? ("ai" as const) : ("team" as const),
          priority: c.priority,
          sample: c.sample,
          lastMessageAt: c.lastMessageAt,
          waitingSince: c.waitingSince,
          snoozedUntil: c.snoozedUntil,
          name: person.name ?? person.email ?? "Unknown",
          image: c.user?.image ?? null,
          company: companies.get(c.id) ?? null,
          unread: reads.get(c.id)?.unread ?? false,
          assignee: c.assignee,
          line: (text && (by ? `${by}: ${text}` : text)) || null,
          match: match ? { note: match.note, snippet: match.snippet } : null,
        };
      }),
      projectName: project.name,
      admin: isAdminRole(member.role),
      supportInbox: project.supportInbox,
      plan: project.plan,
      emailNewConversations: member.emailNewConversations,
      stats,
    };
  },
});

/** "Email me new conversations": the teammate's own choice, in the Inbox's options (for a key, its creator's). */
export const setNewConversationEmails = defineOperation({
  name: "inbox.newConversationEmails",
  title: "Email me new conversations",
  summary: "Turn the emails about new conversations on or off for yourself.",
  method: "POST",
  internal: true,
  scope: "write",
  access: "team",
  input: z.object({ on: z.boolean() }),
  output: z.object({ on: z.boolean() }),
  run: async ({ actor, projectId }, { on }) => {
    await prisma.teamMember.update({ where: { projectId_userId: { projectId, userId: teamMemberId(actor) } }, data: { emailNewConversations: on } });
    return { on };
  },
});
