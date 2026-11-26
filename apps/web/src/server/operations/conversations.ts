import { type ConversationOrigin, type ConversationOwner, type ConversationStatus, type MessageAuthor, type MessageChannel, Prisma, prisma } from "@tuti/db";
import { enqueue, historySince, inSomePlansHistory, replyTranslation, translationFailed, translationSettings, visibleConversations } from "@tuti/jobs";
import { aiEnabled, log } from "@tuti/shared";
import { z } from "zod";

import { rowLine, subjectFrom } from "@/lib/format";
import { appUrl } from "@/lib/hosts";
import { isAdminRole } from "@/lib/roles";
import { SPAM_REASON_KEYS, type SpamReason } from "@/lib/spam-reasons";

import { attachmentLinks, checkUploads, claimUploads, startUpload } from "../attachments";
import { conversationReads } from "../conversation-reads";
import { portalAddress } from "../custom-domains";
import { readerToSend, searchDocs } from "../docs-search";
import { emitEvent } from "../events";
import { conversationCompanies } from "../inbox-companies";
import { notifyInbox, notifyInboxNow } from "../live";
import { onlineUntil, presenceKey } from "../presence";
import { namedProjectUser } from "../project-users";
import { blockDomainOf, recordMark } from "../spam";
import { type Actor, defineOperation, OperationError } from "./define";
import { findPost, postNumber, projectSlug, STATUSES as POST_STATUSES, toApiStatus as toPostStatus } from "./read";

/** The support inbox (docs/plan.md, Support inbox): conversations between a project's users and its team. */

export const CONVERSATION_STATUSES = ["open", "waiting", "closed"] as const;
export const toApiStatus = (status: ConversationStatus) => status.toLowerCase() as (typeof CONVERSATION_STATUSES)[number];

/** Who has a conversation (docs/plan.md, Inbox automation: one owner per conversation), as the API says it. */
const HANDLERS = ["ai", "team"] as const;

export const MAX_MESSAGE_LENGTH = 10_000;
const MAX_SUBJECT_LENGTH = 200;

export const conversationNumber = z.coerce.number().int().positive().describe("The conversation's number in the project").meta({ examples: [12] });
const body = z
  .string()
  .trim()
  .min(1, "Write something first")
  .max(MAX_MESSAGE_LENGTH)
  .describe("The message: plain text, up to 10,000 characters")
  .meta({ examples: ["The export button does nothing on the reports page."] });
const linkedPost = postNumber.describe("The post's number").meta({ examples: [7] });

/** Someone from the project's app, matched by their id there (as with SSO), like `author` elsewhere. */
const appUser = z.object({
  id: z.string().min(1).max(255).describe("Their id in your app").meta({ examples: ["user-42"] }),
  name: z.string().trim().min(1).max(100).optional().describe("Their name").meta({ examples: ["Sam Lee"] }),
  email: z.email().max(320).optional().describe("Their email address").meta({ examples: ["sam@example.com"] }),
});

/** When something happened, as the API sends it. */
const at = (description: string) => z.string().describe(`${description} (ISO 8601)`).meta({ examples: ["2026-11-18T09:30:00.000Z"] });

const conversationUserOutput = z
  .object({
    id: z.string().nullable().describe("Their id in your app, when they came through SSO or the API; null otherwise (an email, a portal account, a signed-out visitor)").meta({ examples: ["user-42"] }),
    name: z.string().nullable().describe("Their name: for someone known by email only, the name their email came from, once its address is verified").meta({ examples: ["Sam Lee"] }),
    email: z.string().nullable().describe("Their email address; null for a signed-out visitor, or someone from your app who hasn't given one").meta({ examples: ["sam@example.com"] }),
    verified: z.boolean().describe("Whether the address is known to be theirs: always for someone from your app").meta({ examples: [true] }),
  })
  .meta({ id: "ConversationUser", description: "Who a conversation is with: someone from your app or with a portal account, an email address, or a signed-out visitor" });

const conversationFields = {
  number: z.number().int().describe("The conversation's number in the project").meta({ examples: [12] }),
  subject: z.string().describe("Its subject: the one it was started with, or the start of its first message").meta({ examples: ["Can't export to CSV"] }),
  status: z
    .enum(CONVERSATION_STATUSES)
    .describe("open: waiting on the team; waiting: on the user (the team's reply is its latest message); closed: done with")
    .meta({ examples: ["open"] }),
  origin: z
    .enum(["widget", "email", "escalation", "api"])
    .describe("Where it started: the widget, an email, an AI answer passed to a person (escalation), or the API")
    .meta({ examples: ["widget"] }),
  user: conversationUserOutput,
  assignee: z
    .object({
      name: z.string().describe("Their name in Tuti").meta({ examples: ["Olive Owner"] }),
      email: z.string().describe("Their email address").meta({ examples: ["olive@example.com"] }),
    })
    .nullable()
    .describe("The team member it's assigned to; null when unassigned"),
  spam: z.boolean().describe("Marked as spam: lists leave it out unless asked for").meta({ examples: [false] }),
  spamReason: z
    .enum(SPAM_REASON_KEYS)
    .nullable()
    .describe(
      "Why the spam filter filed it: blocked_address or blocked_domain (on the team's blocked list), marked_sender (an earlier conversation from this sender was marked as spam), dmarc_failed (its email failed DMARC), flood (too many new conversations by email from this address in an hour) or phrase (its subject or first message has one of the team's phrases). Null when it isn't spam, and when a teammate marked it",
    )
    .meta({ examples: [null] }),
  handledBy: z
    .enum(HANDLERS)
    .describe("Who has it: team, or ai. The AI's are in the Inbox's With AI view and out of its others, and the team isn't emailed or notified about them; a teammate's reply (not a note) takes one over. Nothing answers for the AI yet: one it has waits there, with nobody told, till a teammate takes it over")
    .meta({ examples: ["team"] }),
  priority: z.boolean().describe("Marked priority: the Inbox's list says so on its row").meta({ examples: [false] }),
  lastMessageAt: at("When its latest message was written; notes don't move it"),
  waitingSince: at("Since when the user has waited on the team: their oldest unanswered message; null when they aren't waiting").nullable(),
  snoozedUntil: at("Out of the inbox's views till then, or till the user writes (one the AI has stays in With AI); null when not snoozed (closed and spam ones never are)")
    .nullable()
    .meta({ examples: [null] }),
  createdAt: at("When it started"),
  url: z.string().describe("Its page in Tuti's inbox").meta({ examples: ["https://tuti.example.com/app/acme/inbox/12"] }),
};

/** What the Inbox shows of a conversation beyond its own fields: in conversations.list and conversations.get. */
const inboxFields = {
  company: z
    .string()
    .nullable()
    .describe("The company they're at, as your app says (their `company` property; for someone known by a verified address, that of your user with it); null when it says none")
    .meta({ examples: ["Acme"] }),
  unread: z
    .boolean()
    .describe("Whether the user has written since the teammate asking last read it (conversations.markRead); for an API key, the teammate who created it")
    .meta({ examples: [true] }),
};

/** Whether a message is the asking teammate's own: the Inbox says "You" for it, whoever else has their name. */
const fromYou = z
  .boolean()
  .describe("Whether the teammate asking wrote it; for an API key, the teammate who created it")
  .meta({ examples: [false] });

const latestMessageOutput = z
  .object({
    author: z.enum(["user", "team", "ai", "tuti"]).describe("Who wrote it").meta({ examples: ["user"] }),
    name: z.string().nullable().describe("The teammate who wrote it; null for anyone else's").meta({ examples: [null] }),
    fromYou,
    fromAddress: z.string().nullable().describe("Someone else on the email thread (a Cc'd colleague, say) wrote it: the address they wrote from, or `Deleted user` once they're erased. Null for the conversation's own person, and for messages that didn't come by email").meta({ examples: [null] }),
    line: z
      .string()
      .nullable()
      .describe("Its first line, up to 140 characters, as the Inbox's list shows it under the subject; null when it only says what the subject does")
      .meta({ examples: ["The export button does nothing on the reports page."] }),
  })
  .meta({ id: "ConversationLatestMessage", description: "A conversation's latest message (never a note), as the Inbox's list shows it" });

const matchOutput = z
  .object({
    messageId: z.string().describe("The message's id, as conversations.get lists it").meta({ examples: ["cm3k9x2ab0002qz8h9c4b7a3d"] }),
    author: z.enum(["user", "team", "ai", "tuti"]).describe("Who wrote it").meta({ examples: ["user"] }),
    note: z.boolean().describe("Whether it's an internal note").meta({ examples: [false] }),
    snippet: z
      .string()
      .describe("Its text around the first place it has the search text, on one line, up to 160 characters, cut between words; … where it's cut")
      .meta({ examples: ["…tried twice and the export button does nothing on the reports page. Chrome on a Mac, if that…"] }),
    createdAt: at("When it was written"),
  })
  .meta({ id: "ConversationMatch", description: "The message a search found a conversation by" });

const attachmentOutput = z
  .object({
    id: z.string().describe("The file's id").meta({ examples: ["cm3k9x2ab0001qz8h4f7d2e1c"] }),
    filename: z.string().describe("Its name").meta({ examples: ["screenshot.png"] }),
    contentType: z.string().describe("Its type").meta({ examples: ["image/png"] }),
    size: z.number().int().describe("Its size in bytes").meta({ examples: [48213] }),
    url: z
      .string()
      .nullable()
      .optional()
      .describe("In conversations.get: a link to it, signed for a while (images to show, other files saved under their name); null without media storage")
      .meta({ examples: ["https://media.example.com/attachments/screenshot.png?signature=abc"] }),
  })
  .meta({ id: "ConversationAttachment", description: "A file a message came with, kept in the media storage" });

const messageOutput = z
  .object({
    id: z.string().describe("The message's id").meta({ examples: ["cm3k9x2ab0002qz8h9c4b7a3d"] }),
    author: z
      .enum(["user", "team", "ai", "tuti"])
      .describe("Who wrote it: the user, the team, the AI, or Tuti itself (a notice)")
      .meta({ examples: ["user"] }),
    name: z.string().nullable().describe("The name of whoever wrote it, when they have an account (a teammate, someone from your app); null otherwise").meta({ examples: ["Sam Lee"] }),
    channel: z.enum(["widget", "email", "api", "app"]).describe("How it came: the widget, email, the API or Tuti's app").meta({ examples: ["widget"] }),
    body: z.string().describe("What it says, plain text").meta({ examples: ["The export button does nothing on the reports page."] }),
    note: z.boolean().describe("An internal note: only the team sees it, never sent").meta({ examples: [false] }),
    attachments: z.array(attachmentOutput).describe("The files it came with"),
    attachmentsDropped: z.number().int().describe("How many files it came with couldn't be kept (no media storage, or an import couldn't copy them)").meta({ examples: [0] }),
    teamText: z
      .string()
      .nullable()
      .describe(
        "Translated (Translate conversations): the text in the team's language, the user's message translated or the team's reply as it was written; `body` is then the user's side (what they wrote, or the translation they got). Null when it wasn't translated",
      )
      .meta({ examples: [null] }),
    language: z.string().nullable().describe("The language `body` is in (a BCP 47 code), where it was translated or the user's message was checked for it; null otherwise").meta({ examples: [null] }),
    translationError: z
      .string()
      .nullable()
      .describe("Why the user's message couldn't be translated (it shows as they wrote it); null otherwise")
      .meta({ examples: [null] }),
    createdAt: at("When it was written"),
  })
  .meta({ id: "ConversationMessage", description: "A message in a conversation, or the team's note" });

const linkedPostOutput = z
  .object({
    number: z.number().int().describe("The post's number").meta({ examples: [7] }),
    title: z.string().describe("Its title").meta({ examples: ["Export to CSV"] }),
    status: z.enum(POST_STATUSES).describe("Where it is on the roadmap").meta({ examples: ["planned"] }),
  })
  .meta({ id: "ConversationPost", description: "A post a conversation is linked to" });

const linkedPostsOutput = z
  .object({ posts: z.array(linkedPostOutput).describe("The posts it's linked to, the first linked first") })
  .describe("The conversation's posts as they are now");

const conversationSelect = {
  id: true,
  number: true,
  subject: true,
  status: true,
  origin: true,
  email: true,
  name: true,
  emailVerified: true,
  spam: true,
  spamReason: true,
  handledBy: true,
  priority: true,
  lastMessageAt: true,
  waitingSince: true,
  snoozedUntil: true,
  createdAt: true,
  assignee: { select: { name: true, email: true } },
  user: { select: { name: true, email: true, deletedAt: true, ssoIdentity: { select: { externalId: true, email: true } } } },
} satisfies Prisma.ConversationSelect;

type ConversationRow = Prisma.ConversationGetPayload<{ select: typeof conversationSelect }>;

const messageSelect = {
  id: true,
  author: true,
  channel: true,
  body: true,
  note: true,
  createdAt: true,
  authorUser: { select: { name: true } },
  attachments: { orderBy: { createdAt: "asc" }, select: { id: true, filename: true, contentType: true, size: true } },
  attachmentsDropped: true,
  teamText: true,
  language: true,
  translationError: true,
} satisfies Prisma.ConversationMessageSelect;

type MessageRow = Prisma.ConversationMessageGetPayload<{ select: typeof messageSelect }>;

/**
 * Who a conversation is with: someone Tuti knows (their id in your app when they came through SSO
 * or the API) or just an email, with the name its first email came from. An SSO user's User.email is a
 * placeholder, so their app's email shows.
 */
export function conversationPerson(row: Pick<ConversationRow, "user" | "email" | "name" | "emailVerified">) {
  if (row.user) {
    const sso = row.user.ssoIdentity;
    // A deleted user's account address is a placeholder too.
    return { id: sso?.externalId ?? null, name: row.user.name, email: sso ? sso.email : row.user.deletedAt ? null : row.user.email, verified: true };
  }
  // The name their email gave only once its address is verified: anyone can give any name, and the list would show it
  // alone (as with the company, conversationCompanies). Unverified, they're their address.
  return { id: null, name: row.emailVerified ? row.name : null, email: row.email, verified: row.emailVerified };
}

function view(row: ConversationRow, slug: string) {
  return {
    number: row.number,
    subject: row.subject,
    status: toApiStatus(row.status),
    origin: row.origin.toLowerCase(),
    user: conversationPerson(row),
    assignee: row.assignee,
    spam: row.spam,
    // Only of what's in Spam: a release from before unmarks without clearing it, while a deploy overlaps the two.
    spamReason: row.spam ? (row.spamReason as SpamReason | null) : null,
    handledBy: row.handledBy.toLowerCase(),
    priority: row.priority,
    lastMessageAt: row.lastMessageAt,
    waitingSince: row.waitingSince,
    /** Out of the inbox's views till then (null: not snoozed, or no longer; never closed or spam ones). */
    snoozedUntil: row.snoozedUntil && row.snoozedUntil > new Date() && row.status !== "CLOSED" && !row.spam ? row.snoozedUntil : null,
    createdAt: row.createdAt,
    url: new URL(`/app/${slug}/inbox/${row.number}`, appUrl()).toString(),
  };
}

function messageView(row: MessageRow) {
  return {
    id: row.id,
    author: row.author.toLowerCase(),
    name: row.authorUser?.name ?? null,
    channel: row.channel.toLowerCase(),
    body: row.body,
    note: row.note,
    /** The files it came with (kept in the media storage), and how many couldn't be kept (no storage). */
    attachments: row.attachments,
    attachmentsDropped: row.attachmentsDropped,
    teamText: row.teamText,
    language: row.language,
    translationError: row.translationError,
    createdAt: row.createdAt,
  };
}

/**
 * Each conversation's latest message (not a note; by id where two share a time), its start only, with who wrote it
 * (a team member's id and name): one read each, from the newest back along the (conversation, time) index, not its
 * whole history. By conversation id.
 */
export async function latestMessages(ids: string[]) {
  const rows = ids.length
    ? await prisma.$queryRaw<{ conversationId: string; body: string; author: MessageAuthor; authorId: string | null; name: string | null; fromAddress: string | null }[]>`
        SELECT c.id AS "conversationId", m.body, m.author, m."authorId", u.name, m."fromAddress" FROM unnest(${ids}::text[]) AS c(id)
        CROSS JOIN LATERAL (
          SELECT left(body, 1000) AS body, author, "authorId", "fromAddress" FROM conversation_message
          WHERE "conversationId" = c.id AND NOT note ORDER BY "createdAt" DESC, id DESC LIMIT 1
        ) m
        LEFT JOIN "user" u ON u.id = m."authorId"`
    : [];
  return new Map(rows.map(({ conversationId, ...message }) => [conversationId, message]));
}

/**
 * A conversation by its number, unless it's past the plan's history (historySince); with `hidden`, even then (a message
 * from its user joins it, as an email reply does, and shows it again).
 */
export async function findConversation(projectId: string, number: number, { hidden = false } = {}) {
  const history = hidden ? null : await historySince(projectId);
  const conversation = await prisma.conversation.findUnique({
    where: { projectId_number: { projectId, number }, AND: [visibleConversations(history)] },
    select: { ...conversationSelect, userId: true, visitorHash: true },
  });
  if (!conversation) {
    const past = history && (await prisma.conversation.findUnique({ where: { projectId_number: { projectId, number } }, select: { activeAt: true, updatedAt: true } }));
    // An upgrade shows it while it's in some plan's history; past every plan's, nothing does (and it's soon deleted).
    const hint = past && inSomePlansHistory(past) ? ": upgrade to see it again" : "";
    throw new OperationError(404, "not_found", past ? `Conversation #${number} is past your plan's history${hint}` : `There's no conversation #${number}`);
  }
  return conversation;
}

/**
 * Not snoozed: never, no longer (its time passed; the wake job opens it soon after), or closed or spam (done with,
 * whatever snooze a release from before left on it).
 */
export const awake = (now = new Date()): Prisma.ConversationWhereInput => ({
  OR: [{ snoozedUntil: null }, { snoozedUntil: { lte: now } }, { status: "CLOSED" }, { spam: true }],
});

/** The team member writing or looking: the signed-in one, or for an API key, the one who created it. */
const teamMemberId = (actor: Actor) => (actor.kind === "user" ? actor.userId : actor.createdById);

/** The Inbox's views, in its order (what needs an answer first, then the rest), each by its name there. */
export const INBOX_VIEWS = {
  open: "Needs reply",
  mine: "Mine",
  unassigned: "Unassigned",
  waiting: "Waiting on user",
  ai: "With AI",
  snoozed: "Snoozed",
  closed: "Closed",
  spam: "Spam",
} as const;

export type InboxView = keyof typeof INBOX_VIEWS;
const VIEW_NAMES = Object.keys(INBOX_VIEWS) as [InboxView, ...InboxView[]];

/**
 * A view's conversations: always this project's, whatever the view; snoozed ones only in Snoozed (till it passes). With
 * `since` (historySince), closed ones from before it are past the plan's history: in no view. Mine is `userId`'s.
 * Those the AI has (docs/plan.md, Inbox automation) are in With AI alone, snoozed or not, till they're closed or spam:
 * Closed and Spam list what's done with, whoever had it, so every conversation is in some view.
 */
export function viewWhere(view: InboxView, projectId: string, userId: string, since: Date | null = null): Prisma.ConversationWhereInput {
  const now = new Date();
  const filters: Record<InboxView, Prisma.ConversationWhereInput> = {
    open: { spam: false, handledBy: "TEAM", status: "OPEN", ...awake(now) },
    mine: { spam: false, handledBy: "TEAM", assigneeId: userId, status: { not: "CLOSED" }, ...awake(now) },
    unassigned: { spam: false, handledBy: "TEAM", assigneeId: null, status: "OPEN", ...awake(now) },
    waiting: { spam: false, handledBy: "TEAM", status: "WAITING", ...awake(now) },
    ai: { spam: false, handledBy: "AI", status: { not: "CLOSED" } },
    // Closed is done with, snoozed or not (a snooze left on one, by a release from before, doesn't hide it).
    snoozed: { spam: false, handledBy: "TEAM", status: { not: "CLOSED" }, snoozedUntil: { gt: now } },
    closed: { spam: false, status: "CLOSED" },
    spam: { spam: true },
  };
  return { AND: [filters[view], visibleConversations(since)], projectId };
}

/** How many conversations each view has, in the views' order: the Inbox's numbers beside them, and conversations.views'. */
export const viewCounts = (projectId: string, userId: string, since: Date | null) =>
  Promise.all(VIEW_NAMES.map((view) => prisma.conversation.count({ where: viewWhere(view, projectId, userId, since) })));

/**
 * What the Inbox says of these conversations (ids) beyond their own fields, for the team member looking (`userId`): the
 * company their person is at, and whether they've written since that member read it. By conversation id.
 */
async function inboxDetails(projectId: string, userId: string, ids: string[]) {
  const rows = await prisma.conversation.findMany({
    where: { projectId, id: { in: ids } },
    select: { id: true, userId: true, email: true, emailVerified: true, user: { select: { email: true, emailVerified: true, ssoIdentity: { select: { properties: true } } } } },
  });
  const [companies, reads] = await Promise.all([conversationCompanies(projectId, rows), conversationReads(ids, userId)]);
  return new Map(ids.map((id) => [id, { company: companies.get(id) ?? null, unread: reads.get(id)?.unread ?? false }]));
}

export const listInboxViews = defineOperation({
  name: "conversations.views",
  title: "List the Inbox's views",
  summary:
    "List the Inbox's views with how many conversations each has now, as Tuti's app shows them beside its list. conversations.list's `view` lists one's conversations. Mine is the signed-in teammate's; an API key's is the teammate who created it.",
  method: "GET",
  path: "/inbox/views",
  scope: "read",
  access: "team",
  input: z.object({}),
  output: z
    .object({
      views: z
        .array(
          z
            .object({
              view: z.enum(VIEW_NAMES).describe("The view, as conversations.list's `view` takes it").meta({ examples: ["open"] }),
              title: z.string().describe("Its name in Tuti's app").meta({ examples: ["Needs reply"] }),
              count: z.number().int().describe("How many conversations are in it now").meta({ examples: [4] }),
            })
            .meta({ id: "InboxView", description: "One of the Inbox's views, with how many conversations it has" }),
        )
        .describe("The views, in the Inbox's order: what needs a reply first"),
    })
    .describe("The Inbox's views and their counts"),
  run: async ({ actor, projectId }) => {
    const counts = await viewCounts(projectId, teamMemberId(actor), await historySince(projectId));
    return { views: VIEW_NAMES.map((name, i) => ({ view: name, title: INBOX_VIEWS[name], count: counts[i]! })) };
  },
});

/** Who a conversation can be assigned to: the project's team, in the order they joined, as the Inbox's picker lists them. */
export const assignableTeam = (projectId: string) =>
  prisma.teamMember.findMany({
    where: { projectId },
    orderBy: { createdAt: "asc" },
    select: { userId: true, user: { select: { name: true, email: true, image: true } } },
  });

export const listAssignees = defineOperation({
  name: "conversations.assignees",
  title: "List who to assign to",
  summary:
    "List the teammates a conversation can be assigned to, in the order they joined, as Tuti's app offers them: each with the address conversations.update's `assignee` takes, and which one is you.",
  method: "GET",
  path: "/inbox/assignees",
  scope: "read",
  access: "team",
  input: z.object({}),
  output: z
    .object({
      assignees: z
        .array(
          z
            .object({
              name: z.string().describe("Their name in Tuti").meta({ examples: ["Olive Owner"] }),
              email: z.string().describe("Their email address: conversations.update's `assignee`").meta({ examples: ["olive@example.com"] }),
              image: z.string().nullable().describe("A link to their picture; null when they have none (the app shows their initial)").meta({ examples: ["https://tuti.example.com/api/media/abc/64.webp?s=x"] }),
              you: z.boolean().describe("Whether it's the signed-in teammate; for an API key, the teammate who created it").meta({ examples: [true] }),
            })
            .meta({ id: "Assignee", description: "A teammate a conversation can be assigned to" }),
        )
        .describe("The team, in the order they joined"),
    })
    .describe("Who conversations can be assigned to"),
  run: async ({ actor, projectId }) => {
    const me = teamMemberId(actor);
    const team = await assignableTeam(projectId);
    return { assignees: team.map(({ userId, user }) => ({ name: user.name, email: user.email, image: user.image, you: userId === me })) };
  },
});

/** A team member by their email, for assigning. */
async function teamMemberByEmail(projectId: string, email: string) {
  const member = await prisma.teamMember.findFirst({
    where: { projectId, user: { email: email.toLowerCase() } },
    select: { userId: true },
  });
  if (!member) {
    throw new OperationError(404, "not_found", `${email} isn't on the project's team`);
  }
  return member.userId;
}

/** The longest text a search takes. */
export const MAX_SEARCH_LENGTH = 200;

/** Text for a `contains` (a LIKE): its wildcards, and the escape, typed as themselves. */
const likeText = (q: string) => q.replace(/[\\%_]/g, "\\$&");

/**
 * The conversations a search for `q` finds, whatever the case: the one with that number (`12` or `#12`), and those with
 * the text in their subject, in who they're with as the Inbox shows them (conversationPerson's name and email; their
 * company, conversationCompanies'), or in a message or note. For the team only: notes are theirs. The index of a
 * project's messages by their text's trigrams answers the last (the project's messages alone under three characters).
 * ponytail: an address-linked company is found through at most 1,000 of the project's users at companies with the text,
 * any of those sharing the address (the Inbox shows the oldest one's); join conversations to identities in SQL if a
 * project outgrows that.
 */
export async function conversationsMatching(projectId: string, q: string): Promise<Prisma.ConversationWhereInput> {
  const has = { contains: likeText(q), mode: "insensitive" as const };
  const atCompany = { path: ["company"], string_contains: likeText(q), mode: "insensitive" as const };
  const asNumber = /^#?\d{1,10}$/.test(q) ? Number(q.replace("#", "")) : null;
  // The project's users at such a company, by address: someone writing from a verified one is at theirs. In SQL: the
  // database stops at 1,000 addresses (Prisma's `distinct` reads every row first), the same ones on every page.
  const colleagues = await prisma.$queryRaw<{ email: string }[]>`
    SELECT DISTINCT email FROM sso_identity
    WHERE "projectId" = ${projectId} AND email IS NOT NULL
      AND jsonb_typeof(attributes -> 'company') = 'string' AND attributes ->> 'company' ILIKE ${`%${likeText(q)}%`}
    ORDER BY email LIMIT 1000`;
  const addresses = colleagues.map((colleague) => colleague.email);
  return {
    OR: [
      // A number as conversations have them (a 32-bit integer).
      ...(asNumber !== null && asNumber <= 2_147_483_647 ? [{ number: asNumber }] : []),
      { subject: has },
      // Someone known by their address alone: the name it came with only once it's verified, as shown.
      { userId: null, email: has },
      { userId: null, emailVerified: true, name: has },
      // An account: its name; the address your app gave (the account's own is a placeholder then, as a deleted one's is).
      { user: { OR: [{ name: has }, { ssoIdentity: { OR: [{ email: has }, { properties: atCompany }] } }, { ssoIdentity: null, deletedAt: null, email: has }] } },
      ...(addresses.length > 0
        ? [
            { userId: null, emailVerified: true, email: { in: addresses } },
            { user: { ssoIdentity: null, emailVerified: true, email: { in: addresses }, teamMemberships: { none: { projectId } } } },
          ]
        : []),
      // With its project, so the search reads this project's messages only.
      // A translated message's team-side text too (its own index, as `body`'s).
      { messages: { some: { projectId, body: has } } },
      { messages: { some: { projectId, teamText: has } } },
    ],
  };
}

/** How much of a message a search's snippet shows, and how much of that comes before the text found. */
const SNIPPET_LENGTH = 160;
const SNIPPET_LEAD = 30;

/**
 * Where a search for `q` found each of these conversations (ids) in a message: the newest message or note with the text,
 * and its text around the first place it has it, on one line, in whole words where there's a space to cut at. By conversation id; none for one found by its number,
 * subject or person alone.
 */
export async function matchedMessages(ids: string[], q: string) {
  const rows = ids.length
    ? await prisma.$queryRaw<{ conversationId: string; id: string; author: MessageAuthor; note: boolean; createdAt: Date; text: string; from: number; length: number }[]>`
        SELECT c.id AS "conversationId", m.id, m.author, m.note, m."createdAt", m.length, m."from", substring(m.body FROM m."from" FOR ${SNIPPET_LENGTH}) AS text
        FROM unnest(${ids}::text[]) AS c(id)
        CROSS JOIN LATERAL (
          SELECT cm.id, cm.author, cm.note, cm."createdAt", t.body, length(t.body) AS length, greatest(position(lower(${q}) IN lower(t.body)) - ${SNIPPET_LEAD}, 1) AS "from"
          FROM conversation_message cm
          -- The text that has it: the message's own, else its translation (teamText).
          CROSS JOIN LATERAL (SELECT CASE WHEN cm.body ILIKE ${`%${likeText(q)}%`} THEN cm.body ELSE cm."teamText" END AS body) t
          WHERE cm."conversationId" = c.id AND (cm.body ILIKE ${`%${likeText(q)}%`} OR cm."teamText" ILIKE ${`%${likeText(q)}%`})
          ORDER BY cm."createdAt" DESC, cm.id DESC LIMIT 1
        ) m`
    : [];
  return new Map(
    rows.map((row) => {
      const [before, after] = [row.from > 1, row.from + SNIPPET_LENGTH <= row.length];
      // Whole words where it's cut: not the rest of one before the text found, nor the start of one in its last 30 characters.
      const start = before ? row.text.replace(new RegExp(`^\\S{0,${SNIPPET_LEAD - 1}}\\s+`), "") : row.text;
      const words = after ? start.replace(/(?<=^[^]{130,})\s+\S*$/, "") : start;
      return [
        row.conversationId,
        {
          messageId: row.id,
          author: row.author.toLowerCase(),
          note: row.note,
          snippet: `${before ? "…" : ""}${words.replace(/\s+/g, " ").trim()}${after ? "…" : ""}`,
          createdAt: row.createdAt,
        },
      ];
    }),
  );
}

export const listConversations = defineOperation({
  name: "conversations.list",
  title: "List conversations",
  summary: "List conversations, latest message first, a page at a time: one of the Inbox's views with `view`, or search them with `q`. Spam is left out unless asked for.",
  method: "GET",
  path: "/conversations",
  scope: "read",
  access: "team",
  errors: [404],
  input: z.object({
    q: z
      .string()
      .trim()
      .max(MAX_SEARCH_LENGTH)
      .optional()
      .describe(
        "Only those with this text, whatever the case, in their subject, their person's name, email or company, or a message or note; a number (`12` or `#12`) finds that conversation too. With the other filters: every status unless `status` says one",
      )
      .meta({ examples: ["refund"] }),
    view: z
      .enum(VIEW_NAMES)
      .optional()
      .describe(
        "Only those in this view of the Inbox, as conversations.views counts them: open (needs a reply), mine (assigned to the signed-in teammate, or to whoever created the API key; not closed), unassigned (and open), waiting (on the user), ai (those the AI has, till they're closed or spam: they're in none of the others before), snoozed, closed or spam. The team's snoozed ones are only in snoozed; the AI's stay in ai. It decides spam: `spam` isn't read with it",
      )
      .meta({ examples: ["open"] }),
    status: z.enum(CONVERSATION_STATUSES).optional().describe("Only those with this status").meta({ examples: ["open"] }),
    assignee: z
      .union([z.literal("none"), z.email()])
      .optional()
      .describe('Only those assigned to this team member, by their email, or "none" for unassigned ones')
      .meta({ examples: ["olive@example.com"] }),
    user: z.string().min(1).max(255).optional().describe("Only those with this person from your app, by their id there").meta({ examples: ["user-42"] }),
    spam: z.stringbool().default(false).describe("true lists spam only"),
    snoozed: z.stringbool().optional().describe("true lists only those snoozed now, false leaves them out; either when not given"),
    limit: z.coerce.number().int().min(1).max(100).default(25).describe("How many to return, 1 to 100").meta({ examples: [25] }),
    cursor: z.coerce.number().int().min(0).default(0).describe("Where to start: the previous page's `nextCursor`").meta({ examples: [25] }),
  }),
  output: z
    .object({
      conversations: z
        .array(
          z
            .object({
              ...conversationFields,
              ...inboxFields,
              latestMessage: latestMessageOutput.nullable().describe("Its latest message, as the Inbox's list shows it; null when it has none but notes"),
              match: matchOutput
                .nullable()
                .describe("With `q`: the newest message or note with the text; null when none has it (its number, subject or person does), and without `q`"),
            })
            .meta({ id: "Conversation", description: "A conversation between someone and the team; in a search, with the message it was found by" }),
        )
        .describe("The conversations, latest message first"),
      nextCursor: z.string().nullable().describe("The next page's `cursor`; null on the last page").meta({ examples: ["25"] }),
      total: z.number().int().describe("How many conversations the filters find in all, on every page").meta({ examples: [42] }),
    })
    .describe("A page of conversations"),
  example: { view: "open", limit: 10 },
  run: async ({ actor, projectId }, input) => {
    const assigneeId =
      input.assignee === undefined || input.assignee === "none" ? null : await teamMemberByEmail(projectId, input.assignee);
    const me = teamMemberId(actor);
    const history = await historySince(projectId);
    const where: Prisma.ConversationWhereInput = {
      projectId,
      ...(!input.view && { spam: input.spam }),
      ...(input.status && { status: input.status.toUpperCase() as ConversationStatus }),
      ...(input.assignee !== undefined && { assigneeId }),
      ...(input.user && { user: { ssoIdentity: { projectId, externalId: input.user } } }),
      // With the status asked for, if any (each a condition of its own, so neither takes the other's place). Not those
      // past the plan's history. A view is the Inbox's own filter (viewWhere), so the two list the same.
      AND: [
        input.view ? viewWhere(input.view, projectId, me, history) : visibleConversations(history),
        ...(input.q ? [await conversationsMatching(projectId, input.q)] : []),
        ...(input.snoozed === true ? [{ snoozedUntil: { gt: new Date() } }, { status: { not: "CLOSED" as const } }, { spam: false }] : []),
        ...(input.snoozed === false ? [awake()] : []),
      ],
    };
    // ponytail: offset cursors, like posts.list.
    const [rows, total] = await Promise.all([
      prisma.conversation.findMany({ where, orderBy: [{ lastMessageAt: "desc" }, { number: "desc" }], skip: input.cursor, take: input.limit + 1, select: conversationSelect }),
      prisma.conversation.count({ where }),
    ]);
    const slug = await projectSlug(projectId);
    const page = rows.slice(0, input.limit);
    const ids = page.map((row) => row.id);
    const [matches, latest, details] = await Promise.all([input.q ? matchedMessages(ids, input.q) : null, latestMessages(ids), inboxDetails(projectId, me, ids)]);
    return {
      conversations: page.map((row) => {
        const message = latest.get(row.id);
        return {
          ...view(row, slug),
          ...details.get(row.id)!,
          latestMessage: message
            ? {
                author: message.author.toLowerCase(),
                name: message.author === "TEAM" ? message.name : null,
                fromYou: message.author === "TEAM" && message.authorId === me,
                fromAddress: message.fromAddress,
                line: rowLine(row.subject, message.body) ?? null,
              }
            : null,
          match: matches?.get(row.id) ?? null,
        };
      }),
      nextCursor: rows.length > input.limit ? String(input.cursor + input.limit) : null,
      total,
    };
  },
});

export const getConversation = defineOperation({
  name: "conversations.get",
  title: "Get a conversation",
  summary: "Get a conversation by its number, with its messages and notes, oldest first, and the posts it's linked to",
  method: "GET",
  path: "/conversations/{number}",
  scope: "read",
  access: "team",
  input: z.object({ number: conversationNumber }),
  output: z
    .object({
      ...conversationFields,
      ...inboxFields,
      onlineUntil: at("Till when they count as online: they have the widget's Messages open, or had in the last 2 minutes; null when they aren't").nullable(),
      posts: z.array(linkedPostOutput).describe("The posts it's linked to, the first linked first"),
      messages: z
        .array(
          messageOutput.extend({
            fromYou,
            requestId: z
              .string()
              .nullable()
              .describe(
                "The `requestId` conversations.reply was sent with, on your own messages only (`fromYou`): after a lost answer, it says your reply arrived. Null on everyone else's, and when it had none",
              )
              .meta({ examples: ["3f1c9b2e-7a4d-4e8f-9c21-5b6d8e0f1a23"] }),
            fromAddress: z
              .string()
              .nullable()
              .describe("Someone else on the email thread (a Cc'd colleague, say) wrote it: the address they wrote from, or `Deleted user` once they're erased. Null for the conversation's own person, and for messages that didn't come by email")
              .meta({ examples: [null] }),
            seenAt: at("When the user saw it in the widget; null when they haven't, and for what isn't the team's reply").nullable(),
            emailStatus: z
              .enum(["sent", "delivered", "bounced", "complained", "failed"])
              .nullable()
              .describe("How emailing the team's reply went: sent, delivered, bounced, complained (they marked it as spam) or failed; null when it wasn't emailed, or not yet")
              .meta({ examples: ["delivered"] }),
            emailError: z.string().nullable().describe("Why it bounced or failed, when the mail server said; null otherwise").meta({ examples: [null] }),
          }),
        )
        .describe("Its messages and notes, oldest first"),
    })
    .describe("The conversation"),
  run: async ({ actor, projectId }, { number }) => {
    const conversation = await findConversation(projectId, number);
    const messages = await prisma.conversationMessage.findMany({
      where: { conversationId: conversation.id },
      orderBy: { createdAt: "asc" },
      select: { ...messageSelect, authorId: true, requestId: true, fromAddress: true, seenAt: true, emailStatus: true, emailError: true },
    });
    // Each attachment with a link to it, signed for a while: images to show, other files saved under their name.
    const links = new Map(
      (
        await attachmentLinks(
          await prisma.conversationAttachment.findMany({
            where: { message: { conversationId: conversation.id } },
            select: { id: true, key: true, filename: true, contentType: true },
          }),
        )
      ).map((link) => [link.id, link.url]),
    );
    const online = conversation.userId || conversation.visitorHash ? await onlineUntil(projectId, presenceKey(conversation)) : null;
    const me = teamMemberId(actor);
    return {
      ...view(conversation, await projectSlug(projectId)),
      ...(await inboxDetails(projectId, me, [conversation.id])).get(conversation.id)!,
      onlineUntil: online,
      posts: await linkedPosts(conversation.id),
      messages: messages.map((message) => {
        const shown = messageView(message);
        const fromYou = message.author === "TEAM" && message.authorId === me;
        return {
          ...shown,
          attachments: shown.attachments.map((a) => ({ ...a, url: links.get(a.id) ?? null })),
          fromYou,
          // Another writer's ids are their client's own bookkeeping.
          requestId: fromYou ? message.requestId : null,
          fromAddress: message.fromAddress,
          seenAt: message.seenAt,
          emailStatus: message.emailStatus?.toLowerCase() ?? null,
          emailError: message.emailError,
        };
      }),
    };
  },
});

/** Acknowledges only the customer message shown on the open page, never a newer one that arrived meanwhile. */
export const markConversationRead = defineOperation({
  name: "conversations.markRead",
  title: "Mark a conversation read",
  summary: "Mark a conversation read for the signed-in teammate, up to what their page showed. People only: API keys cannot mark someone else's inbox read (403).",
  method: "POST",
  path: "/conversations/{number}/read",
  scope: "write",
  access: "team",
  input: z.object({
    number: conversationNumber,
    seen: z.iso
      .datetime()
      .nullable()
      .describe("When the latest message the page showed was written: the user's messages up to then are read, never a newer one; null marks none")
      .meta({ examples: ["2026-11-18T09:30:00.000Z"] }),
  }),
  output: z.object({}).describe("Nothing: it's marked read").meta({ examples: [{}] }),
  run: async ({ actor, projectId }, { number, seen }) => {
    if (actor.kind !== "user") {
      throw new OperationError(403, "people_only", "Only signed-in teammates can mark conversations read");
    }
    const conversation = await findConversation(projectId, number);
    // Store message time, not this server's clock. Old tabs and repeated acknowledgements cannot move it back.
    // One atomic statement acknowledges only committed customer messages at or before what the page showed.
    await prisma.$executeRaw`
      INSERT INTO conversation_read ("conversationId", "userId", "readAt")
      SELECT ${conversation.id}, ${actor.userId}, "createdAt"
      FROM conversation_message
      WHERE "conversationId" = ${conversation.id} AND author = 'USER' AND NOT note
        AND "createdAt" <= ${seen}::timestamp
      ORDER BY "createdAt" DESC LIMIT 1
      ON CONFLICT ("conversationId", "userId") DO UPDATE SET "readAt" = EXCLUDED."readAt"
      WHERE conversation_read."readAt" < EXCLUDED."readAt"`;
    return {};
  },
});

export const startReplyUpload = defineOperation({
  name: "conversations.upload",
  title: "Start an attachment upload",
  summary:
    "Start uploading a file for a reply: PUT the file to `uploadUrl` with `contentType` as its Content-Type, then send `id` in conversations.reply's `attachments`. Unsent, it's gone after a day. 50 uploads an hour per teammate. People only: API keys get 403.",
  method: "POST",
  path: "/inbox/uploads",
  scope: "write",
  access: "team",
  errors: [429],
  input: z.object({
    filename: z.string().max(1000).describe("The file's name").meta({ examples: ["invoice.pdf"] }),
    contentType: z.string().max(200).describe("Its type; anything but a plain `type/subtype` is stored as application/octet-stream").meta({ examples: ["application/pdf"] }),
    size: z.number().int().describe("Its size in bytes: up to 10 MB (a reply's files, 25 MB together)").meta({ examples: [48213] }),
  }),
  example: { filename: "invoice.pdf", contentType: "application/pdf", size: 48213 },
  output: z
    .object({
      id: z.string().describe("The upload's id, for conversations.reply's `attachments`").meta({ examples: ["cm3k9x2ab0001qz8h4f7d2e1c"] }),
      contentType: z.string().describe("The Content-Type to PUT it with: the one signed").meta({ examples: ["application/pdf"] }),
      uploadUrl: z.string().describe("Where to PUT exactly this file, signed for a while").meta({ examples: ["https://media.example.com/attachments/abc?signature=xyz"] }),
    })
    .describe("Where to upload the file, and its id"),
  run: async ({ actor, projectId }, file) => {
    if (actor.kind !== "user") {
      throw new OperationError(403, "people_only", "Only signed-in teammates upload attachments");
    }
    return startUpload(projectId, { userId: actor.userId }, file);
  },
});

export const listArticlesToInsert = defineOperation({
  name: "conversations.articles",
  title: "List articles to insert",
  summary:
    "List the published articles matching `q` that the conversation's person can be sent, as Insert article offers them in Tuti's app: listed or unlisted, on a portal they can get into, theirs to read. Up to 10, by their words.",
  method: "GET",
  path: "/conversations/{number}/articles",
  scope: "read",
  access: "team",
  input: z.object({
    number: conversationNumber,
    q: z.string().trim().max(MAX_SEARCH_LENGTH).describe("What to look for in their titles and text; an empty one finds none").meta({ examples: ["refunds"] }),
  }),
  output: z
    .object({
      articles: z
        .array(
          z.object({
            slug: z.string().describe("The article's slug").meta({ examples: ["refunds"] }),
            title: z.string().describe("Its title: the inserted link's text").meta({ examples: ["How refunds work"] }),
            url: z.string().describe("Its page on the portal: the inserted link").meta({ examples: ["https://help.example.com/docs/refunds"] }),
          }),
        )
        .describe("The articles, best match first"),
    })
    .describe("Articles to insert in a reply"),
  example: { q: "refunds" },
  run: async ({ projectId }, { number, q }) => {
    const conversation = await findConversation(projectId, number);
    const reader = q ? await readerToSend(projectId, conversation.userId) : false;
    if (reader === false) {
      return { articles: [] };
    }
    // Words only, as typed (no embedding per keystroke), and not counted as a reader's search in the team's insights.
    const [results, portal] = await Promise.all([
      searchDocs(projectId, q, 10, reader, { log: false, meaning: false, unlisted: true }),
      portalAddress(await projectSlug(projectId)),
    ]);
    return { articles: results.map(({ slug, title }) => ({ slug, title, url: `${portal}/docs/${slug}` })) };
  },
});

export const createConversation = defineOperation({
  name: "conversations.create",
  title: "Start a conversation",
  summary:
    "Start a conversation from someone in your app or an email address, with their first message: open, and waiting on the team, who are emailed about it. Webhooks get `conversation.created`.",
  method: "POST",
  path: "/conversations",
  scope: "write",
  access: "team",
  input: z
    .object({
      user: appUser.optional().describe("Someone from your app, matched by their id there; send this or `email`"),
      email: z.email().max(320).optional().describe("An email address to start it with, for someone not from your app; send this or `user`").meta({ examples: ["sam@example.com"] }),
      subject: z
        .string()
        .trim()
        .min(1)
        .max(MAX_SUBJECT_LENGTH)
        .optional()
        .describe("Its subject, up to 200 characters; without one, the start of the message")
        .meta({ examples: ["Can't export to CSV"] }),
      body,
    })
    .refine((input) => (input.user === undefined) !== (input.email === undefined), "Send either a user or an email")
    .meta({ oneOf: [{ required: ["user"] }, { required: ["email"] }] }),
  example: {
    user: { id: "user-42", name: "Sam", email: "sam@example.com" },
    subject: "Can't export to CSV",
    body: "The export button does nothing on the reports page.",
  },
  output: z.object({ ...conversationFields, messages: z.array(messageOutput).describe("Its first message") }).describe("The conversation started"),
  run: async ({ actor, projectId }, input) => {
    const userId = input.user ? await namedProjectUser(actor, projectId, input.user) : null;
    const { conversation, message } = await startConversation(projectId, {
      userId,
      email: input.email ?? null,
      subject: input.subject,
      body: input.body,
      origin: "API",
      channel: "API",
    });
    return announceConversation(projectId, conversation, message);
  },
});

/**
 * Emails the team about the user's message (packages/jobs, conversation-message) and pushes it to their phones
 * (conversation-push); never fails or holds up the request.
 */
async function tellTeam(projectId: string, messageId: string) {
  const { translateConversations } = await prisma.project.findUniqueOrThrow({ where: { id: projectId }, select: { translateConversations: true } });
  // Side by side: with jobs inline (JOBS_DRIVER=inline) each runs as it's queued, so the push doesn't wait on the email.
  await Promise.all([
    // Translated into the team's language in the background (docs/plan.md L22): the message is already in.
    translateConversations &&
      enqueue("translateMessage", { messageId }).catch(async (error: unknown) => {
        // Shown as written, and marked so the team can try again (L22b): never left looking untranslatable.
        log.error("Enqueueing a message's translation failed", { error, messageId });
        await translationFailed(messageId, "Couldn't queue its translation");
      }),
    enqueue("conversationMessage", { messageId }).catch((error: unknown) => {
      // The message is saved: the conversation-notices-resubmit cron finds it and queues it again.
      log.error("Enqueueing the team's email about a message failed", { error, messageId });
    }),
    enqueue("conversationPush", { messageId }).catch((error: unknown) => {
      // Not queued again: a notification is for now, and the email still tells them.
      log.error("Enqueueing the team's push about a message failed", { error, messageId });
    }),
  ]);
}

/** A new conversation as the API shows it, told to the project's webhooks and team. */
export async function announceConversation(projectId: string, conversation: ConversationRow, message: MessageRow) {
  const result = { ...view(conversation, await projectSlug(projectId)), messages: [messageView(message)] };
  await emitEvent(projectId, "conversation.created", result);
  await tellTeam(projectId, message.id);
  return result;
}

/**
 * A message from the user, told to the project's webhooks and team (the team's own replies aren't, so they don't echo
 * back). Not one written in a conversation in Spam (`inSpam`, addMessage's), which tells nobody: someone the spam filter
 * filed doesn't know it, and writes on. Webhooks hear of those once it's marked Not spam (conversations.update).
 */
export async function announceUserMessage(projectId: string, number: number, message: MessageRow & { inSpam: boolean }) {
  const result = messageView(message);
  if (!message.inSpam) {
    await emitEvent(projectId, "conversation.message_created", { conversation: number, message: result });
    await tellTeam(projectId, message.id);
  }
  return result;
}

/** A new conversation, numbered in the project, with the user's first message: open, and waiting on the team from now. */
export async function startConversation(
  projectId: string,
  start: {
    userId: string | null;
    email: string | null;
    /** With `email`: the name it came from (an email's From). */
    name?: string | null;
    /** A signed-out visitor's, in the widget (lib/visitor-session.ts). */
    visitorHash?: string | null;
    subject?: string;
    body: string;
    origin: ConversationOrigin;
    channel: MessageChannel;
    /** Messages after the user's first, oldest first: an AI answer and the AI's summary as a note, for an escalated question. */
    then?: { author: "AI"; body: string; note?: boolean }[];
    /** Refused (429) when the conversations `where` matches started this many in the last day: checked under the lock, so starts at once can't all pass. */
    perDay?: { where: Prisma.ConversationWhereInput; max: number };
    /**
     * The spam filter (server/spam.ts), run under the project's lock for a conversation a user starts: one it files goes to
     * Spam with the reason, and the caller tells nobody (`conversation.spam`). Without it (the team's own, over the API): never spam.
     */
    filter?: (tx: Prisma.TransactionClient, first: { subject: string | null; text: string }) => Promise<{ spam: boolean; reason: SpamReason | null; phrase?: string }>;
    /** The first message came by email. */
    received?: ReceivedEmail;
    /** More to write in the same transaction (a received email's status, its attachments), with the conversation's and its first message's ids. */
    alongside?: (tx: Prisma.TransactionClient, conversationId: string, messageId: string) => Promise<void>;
  },
) {
  const now = new Date();
  return prisma.$transaction(async (tx) => {
    // Locks the project row, so concurrent conversations get distinct numbers (and limits hold).
    const { conversationCount: number } = await tx.project.update({
      where: { id: projectId },
      data: { conversationCount: { increment: 1 } },
      select: { conversationCount: true },
    });
    if (start.perDay) {
      const started = await tx.conversation.count({
        where: { ...start.perDay.where, projectId, createdAt: { gte: new Date(now.getTime() - 24 * 60 * 60_000) } },
      });
      if (started >= start.perDay.max) {
        throw new OperationError(429, "rate_limited", "You've started a lot of conversations today. Try again tomorrow, or add to one you have.");
      }
    }
    const verdict = await start.filter?.(tx, { subject: start.subject ?? null, text: start.body });
    const created = await tx.conversation.create({
      data: {
        projectId,
        number,
        subject: start.subject ?? subjectFrom(start.body),
        origin: start.origin,
        userId: start.userId,
        email: start.email?.toLowerCase() ?? null,
        name: start.name ?? null,
        visitorHash: start.visitorHash ?? null,
        spam: verdict?.spam ?? false,
        spamReason: verdict?.spam ? verdict.reason : null,
        spamPhrase: (verdict?.spam && verdict.phrase) || null,
        lastMessageAt: now,
        activeAt: now,
        waitingSince: now,
      },
      select: conversationSelect,
    });
    let conversation = created;
    const message = await tx.conversationMessage.create({
      data: {
        projectId,
        conversationId: conversation.id,
        author: "USER",
        authorId: start.userId,
        channel: start.channel,
        body: start.body,
        ...start.received,
        createdAt: now,
      },
      select: messageSelect,
    });
    let first = message;
    if (start.alongside) {
      await start.alongside(tx, conversation.id, message.id);
      // What it wrote with the first message (a received email's attachments) is part of the message announced.
      first = await tx.conversationMessage.findUniqueOrThrow({ where: { id: message.id }, select: messageSelect });
      // And with the conversation (whether a received email's address is verified): it's announced as it is now.
      conversation = await tx.conversation.findUniqueOrThrow({ where: { id: conversation.id }, select: conversationSelect });
    }
    // A millisecond apart, so they read in order.
    await tx.conversationMessage.createMany({
      data: (start.then ?? []).map((next, i) => ({
        projectId,
        conversationId: conversation.id,
        author: next.author,
        channel: start.channel,
        body: next.body,
        note: next.note ?? false,
        createdAt: new Date(now.getTime() + i + 1),
      })),
    });
    await notifyInbox(tx, { projectId, conversationId: conversation.id, number: conversation.number, userId: start.userId, visitorHash: start.visitorHash ?? null, email: conversation.email });
    return { conversation, message: first };
  });
}

/**
 * Adds a message and moves the conversation on: the team replying leaves it Waiting (on the user),
 * the user writing opens it again and keeps how long they've been waiting from their oldest unanswered message.
 */
/** What's kept of a message received by email (see ConversationMessage). */
export type ReceivedEmail = { emailMessageId: string | null; fromAddress: string | null; original: string | null; attachmentsDropped?: number };

export async function addMessage(
  conversationId: string,
  projectId: string,
  message: {
    author: "USER" | "TEAM" | "AI";
    authorId: string | null;
    channel: "API" | "APP" | "WIDGET" | "EMAIL";
    body: string;
    note?: boolean;
    requestId?: string;
    /** A translated reply: the team's own text, and the language `body` is in. */
    teamText?: string;
    language?: string;
  } & Partial<ReceivedEmail>,
  /** More to write in the same transaction (a received email's status), with the new message's id. */
  alongside?: (tx: Prisma.TransactionClient, messageId: string) => Promise<void>,
  /**
   * The team's reply closes it (Send and close), in the same transaction, rather than leaving it waiting on the user; `seen`,
   * the latest message the team saw: one from the user after it (that no teammate has answered since) keeps it open and
   * waiting on the team. `outcome` says what this reply did (not what someone else did after it): closed it, or kept it open.
   */
  { close = false, seen, outcome }: { close?: boolean; seen?: Date; outcome?: { closed?: boolean; keptOpen?: boolean } } = {},
) {
  // Whether it was in Spam as the message was written, read while the conversation is held: its user's message tells
  // nobody then (announceUserMessage), and Not spam, which holds it too, tells of exactly those.
  let inSpam = false;
  const added = await prisma.$transaction(async (tx) => {
    // Every message holds the conversation first, then takes its time: after the conversation's latest (by a millisecond
    // when the clock says no later, or another server's clock runs ahead), so messages' times are the order they're
    // written in. A user message is never older than a reply or note the team has already seen.
    // (The latest read in a statement of its own, after the wait: one written by whoever held it is seen.)
    const [held] = await tx.$queryRaw<{ spam: boolean; spamMarkedAt: Date | null }[]>`
      SELECT "spam", "spamMarkedAt" FROM "conversation" WHERE "id" = ${conversationId} FOR NO KEY UPDATE`;
    inSpam = !!held?.spam;
    const [{ latest }] = await tx.$queryRaw<[{ latest: Date | null }]>`
      SELECT MAX("createdAt") AS latest FROM "conversation_message" WHERE "conversationId" = ${conversationId}`;
    // In Spam, after its mark too, whichever server's clock runs ahead: what was written since the mark is told by its time.
    const marked = held?.spam && held.spamMarkedAt ? held.spamMarkedAt.getTime() + 1 : 0;
    const now = new Date(Math.max(Date.now(), latest ? latest.getTime() + 1 : 0, marked));
    const created = await tx.conversationMessage.create({
      data: { projectId, conversationId, ...message, createdAt: now },
      select: messageSelect,
    });
    let written = created;
    if (alongside) {
      await alongside(tx, created.id);
      // What it wrote with it (a received email's attachments) is part of the message the caller announces.
      written = await tx.conversationMessage.findUniqueOrThrow({ where: { id: created.id }, select: messageSelect });
    }
    const whose = await tx.conversation.findUniqueOrThrow({ where: { id: conversationId }, select: { number: true, userId: true, visitorHash: true, email: true } });
    await notifyInbox(tx, { projectId, conversationId, ...whose });
    if (message.note) {
      // The team's note to itself: nobody replied, and the user mustn't see anything move (their list is by lastMessageAt).
      return written;
    }
    if (message.author === "TEAM") {
      // Held (above): still open (the user wrote last: a teammate's reply sets it waiting, closing closes it) and with a
      // message from the user after what this teammate saw (or, not saying, after this reply was asked for). Then theirs
      // still needs a reply: it stays open and waiting on the team, not closed or waiting on them. Otherwise a snooze whose
      // time has passed (the wake job not there yet) ends with the reply: it's been seen to.
      // A teammate's reply takes it over from the AI (docs/plan.md, Inbox automation), with the reply: never one without the other.
      const [held] = await tx.$queryRaw<[{ status: ConversationStatus }]>`SELECT "status" FROM "conversation" WHERE "id" = ${conversationId}`;
      const [{ unseen }] = await tx.$queryRaw<[{ unseen: boolean }]>`
        SELECT EXISTS (SELECT 1 FROM "conversation_message" WHERE "conversationId" = ${conversationId} AND "author" = 'USER'
          AND NOT "note" AND "createdAt" > ${seen ?? now}) AS unseen`;
      const after = held.status === "OPEN" && unseen;
      await tx.$executeRaw`UPDATE "conversation" SET
        "status" = CASE WHEN ${after} THEN "status" ELSE ${close ? "CLOSED" : "WAITING"}::"ConversationStatus" END,
        "handledBy" = 'TEAM',
        "waitingSince" = CASE WHEN ${after} THEN "waitingSince" ELSE NULL END,
        "lastMessageAt" = GREATEST("lastMessageAt", ${now}),
        "activeAt" = ${now},
        "snoozedUntil" = CASE WHEN (${close} AND NOT ${after}) OR "snoozedUntil" <= ${now} THEN NULL ELSE "snoozedUntil" END,
        "updatedAt" = ${now}
        WHERE "id" = ${conversationId}`;
      if (outcome) {
        outcome.closed = close && !after;
        outcome.keptOpen = after;
      }
    } else {
      // In SQL, so two messages at once keep the older waitingSince.
      // The user writing wakes it if it's snoozed.
      await tx.$executeRaw`UPDATE "conversation" SET "status" = 'OPEN', "waitingSince" = COALESCE("waitingSince", ${now}), "lastMessageAt" = ${now}, "activeAt" = ${now}, "snoozedUntil" = NULL, "updatedAt" = ${now} WHERE "id" = ${conversationId}`;
    }
    return written;
  });
  return { ...added, inSpam };
}

/**
 * The message this writer already sent in this conversation with this `requestId` (conversations.reply), or null. The same
 * id with another message (its text, being a note, its files) is refused: a client's bug, not a retry.
 */
async function sentBefore(
  conversationId: string,
  writer: { author: "USER" | "TEAM"; authorId: string },
  input: { requestId: string; body: string; note?: boolean; attachments?: string[] },
) {
  const sent = await prisma.conversationMessage.findFirst({ where: { conversationId, ...writer, requestId: input.requestId }, select: messageSelect });
  if (!sent) {
    return null;
  }
  const files = (ids: string[]) => [...new Set(ids)].sort().join();
  // A translated reply is compared by the team's own text (a user's message's teamText is its translation, not what they sent).
  if ((writer.author === "TEAM" ? (sent.teamText ?? sent.body) : sent.body) !== input.body || sent.note !== (input.note ?? false) || files(sent.attachments.map((file) => file.id)) !== files(input.attachments ?? [])) {
    throw new OperationError(409, "request_id_used", "This requestId was already used for another reply");
  }
  return sent;
}

export const replyToConversation = defineOperation({
  name: "conversations.reply",
  title: "Reply to a conversation",
  summary:
    "Reply in a conversation as the team, write an internal note, or write as its user. A reply leaves it waiting on the user, unless the user wrote after what the team saw, unanswered: then it stays open and waiting on the team.",
  method: "POST",
  path: "/conversations/{number}/messages",
  scope: "write",
  access: "team",
  errors: [409, 502],
  input: z.object({
    number: conversationNumber,
    body,
    translation: z
      .string()
      .trim()
      .min(1)
      .max(MAX_MESSAGE_LENGTH * 2)
      .optional()
      .describe(
        "Where the conversation is translated: the translation of `body` the team saw (conversations.translateReply), sent to the user as it is, with its `language`. Without it, the reply is translated as it's sent",
      )
      .meta({ examples: ["Danke, Sam! Eine Lösung ist unterwegs."] }),
    language: z
      .string()
      .max(35)
      .optional()
      .describe(
        "With `translation`: the language it's in (conversations.translateReply's `language`). The user's language having changed since, it isn't sent (409 translation_outdated): preview it again",
      )
      .meta({ examples: ["de"] }),
    untranslated: z
      .boolean()
      .optional()
      .describe("Where the conversation is translated and the translation failed: send `body` as written. Without it, a reply that can't be translated isn't sent (502)")
      .meta({ examples: [false] }),
    requestId: z
      .string()
      .min(1)
      .max(100)
      .regex(/^[A-Za-z0-9._:-]+$/, "Letters, digits, and . _ : - only")
      .optional()
      .describe(
        "An id your client makes for this message (up to 100 letters, digits, `.`, `_`, `:` or `-`; a UUID will do). Send the same id again (a retry after a lost answer) and you get the reply already sent, not a second one; the same id with a different message is refused (409). Ids are per conversation and writer",
      )
      .meta({ examples: ["3f1c9b2e-7a4d-4e8f-9c21-5b6d8e0f1a23"] }),
    author: appUser
      .pick({ id: true })
      .optional()
      .describe("Write as the conversation's user, by their id in your app (API keys only; not with `note` or `close`)"),
    note: z.boolean().optional().describe("An internal note: only the team sees it; it's never sent and doesn't change the status").meta({ examples: [false] }),
    close: z
      .boolean()
      .optional()
      .describe("The team's reply closes the conversation (Send and close), rather than leaving it waiting on the user")
      .meta({ examples: [true] }),
    seen: z.iso
      .datetime({ offset: true })
      .transform((at) => new Date(at))
      .optional()
      .describe(
        "When the latest message the team saw was written: one from the user after it keeps the conversation open and waiting on the team (without it, the latest as the reply is asked for)",
      )
      .meta({ examples: ["2026-11-18T09:30:00.000Z"] }),
    attachments: z
      .array(z.string().min(1))
      .max(10)
      .optional()
      .describe("Files uploaded for it in the app (their ids), sent with it: 10 MB each, 25 MB together")
      .meta({ examples: [["cm3k9x2ab0001qz8h4f7d2e1c"]] }),
  }),
  example: { body: "Thanks, Sam! A fix is on its way." },
  output: messageOutput
    .extend({
      keptOpen: z
        .boolean()
        .optional()
        .describe(
          "A reply's (not a note's or the user's): whether it stays open and waiting on the team, as the user wrote after what the team saw (`seen`), unanswered. Not given for a `requestId` already sent",
        )
        .meta({ examples: [false] }),
      closed: z
        .boolean()
        .optional()
        .describe("With `close`: whether it closed the conversation (not when it was kept open). Not given for a `requestId` already sent")
        .meta({ examples: [true] }),
    })
    .describe("The message written"),
  run: async ({ actor, projectId }, input) => {
    // Written as its user (an API key's), it joins one past the plan's history, as their email would.
    const conversation = await findConversation(projectId, input.number, { hidden: !!input.author && actor.kind !== "user" });
    let message: MessageRow & { inSpam: boolean };
    if (input.note && input.author) {
      throw new OperationError(400, "invalid_input", "Notes are the team's: write one without an author");
    }
    if (input.close && (input.note || input.author)) {
      throw new OperationError(400, "invalid_input", "Only the team's reply closes a conversation");
    }
    if (input.attachments?.length && (input.author || actor.kind !== "user")) {
      throw new OperationError(400, "invalid_input", "Attachments are uploaded and sent by a teammate in the app");
    }
    let writer: { author: "USER" | "TEAM"; authorId: string } = { author: "TEAM", authorId: teamMemberId(actor) };
    if (input.author) {
      if (actor.kind === "user") {
        throw new OperationError(403, "forbidden", "Only API keys can write on someone's behalf");
      }
      const identity = await prisma.ssoIdentity.findUnique({
        where: { projectId_externalId: { projectId, externalId: input.author.id } },
        select: { userId: true },
      });
      if (!identity || identity.userId !== conversation.userId) {
        throw new OperationError(403, "forbidden", "Only the conversation's user can write as its user");
      }
      writer = { author: "USER", authorId: identity.userId };
    }
    // A retry of one already sent (its answer was lost) gets it back, and nothing runs again: no message, email, push or
    // webhook. Before the uploads are checked: the first one claimed them.
    const { requestId } = input;
    const repeat = requestId ? await sentBefore(conversation.id, writer, { ...input, requestId }) : null;
    if (repeat) {
      return messageView(repeat);
    }
    // The team writes in its language; where the conversation is translated, the user gets theirs (docs/plan.md L22).
    // Never untranslated unless the team chose it. Notes are the team's own: never translated.
    let translated: { body: string; teamText: string; language: string } | undefined;
    // `untranslated`: the team chose to send it as written ("Send in English"): nothing asked.
    if (writer.author === "TEAM" && !input.note && !input.untranslated) {
      if ((input.translation === undefined) !== (input.language === undefined)) {
        throw new OperationError(400, "invalid_input", "Send `translation` and `language` together");
      }
      const translation = await replyTranslation(projectId, conversation.id, input.body, input.translation ? { text: input.translation, language: input.language! } : undefined);
      if (translation && "outdated" in translation) {
        throw new OperationError(409, "translation_outdated", "The user's language changed since this translation: preview it again");
      }
      if (translation && "error" in translation && !input.untranslated) {
        throw new OperationError(502, "translation_failed", `${translation.error} Send it untranslated (untranslated: true), or try again.`);
      }
      if (translation && "text" in translation) {
        translated = { body: translation.text, teamText: input.body, language: translation.language };
      }
    } else if (input.translation || input.language || (input.untranslated && (writer.author !== "TEAM" || input.note))) {
      throw new OperationError(400, "invalid_input", "Only the team's replies are translated, and `untranslated` sends one without its translation");
    }
    const outcome: { closed?: boolean; keptOpen?: boolean } = {};
    try {
      const uploads = input.attachments?.length && actor.kind === "user" ? await checkUploads(projectId, { userId: actor.userId }, input.attachments) : [];
      message =
        writer.author === "USER"
          ? await addMessage(conversation.id, projectId, { ...writer, channel: "API", body: input.body, requestId })
          : await addMessage(
              conversation.id,
              projectId,
              { ...writer, channel: actor.kind === "user" ? "APP" : "API", body: input.body, note: input.note ?? false, requestId, ...translated },
              uploads.length > 0 ? (tx, messageId) => claimUploads(tx, uploads, messageId) : undefined,
              // Not saying (the API, MCP): what the conversation's latest message was as this reply was asked for, before writing it.
              { close: input.close, seen: input.seen ?? conversation.lastMessageAt, outcome },
            );
    } catch (error) {
      // The same id sent twice at once: the unique index lets one write it, and the other answers with that one. Or the
      // first was written since this one looked, and claimed the uploads this one then found gone (400).
      const raced = (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") || (error instanceof OperationError && error.status === 400);
      const sent = requestId && raced && (await sentBefore(conversation.id, writer, { ...input, requestId }));
      if (sent) {
        return messageView(sent);
      }
      throw error;
    }
    if (message.author === "USER") {
      return announceUserMessage(projectId, conversation.number, message);
    }
    // What this reply did: closed it (when asked to), or kept it open and waiting on the team (the user wrote after what
    // the team saw, unanswered).
    return {
      ...messageView(message),
      ...(!input.note && { keptOpen: outcome.keptOpen === true }),
      ...(input.close && { closed: outcome.closed === true }),
    };
  },
});

export const translateReply = defineOperation({
  name: "conversations.translateReply",
  title: "Preview a reply's translation",
  summary:
    "Where the project translates conversations and the user writes in another language: the reply translated into theirs, as they'd get it (nothing is sent). Send it with conversations.reply's `translation` and `language`.",
  method: "POST",
  path: "/conversations/{number}/reply-translation",
  scope: "write",
  access: "team",
  input: z.object({ number: conversationNumber, body }),
  example: { number: 12, body: "Thanks, Sam! A fix is on its way." },
  output: z
    .object({
      status: z
        .enum(["translated", "not_translated", "failed"])
        .describe(
          "translated: `text` is what the user would get; not_translated: the reply goes as written (translation is off, or their language is the team's or not known yet); failed: it couldn't be translated (`error`), and sending it takes `untranslated`",
        )
        .meta({ examples: ["translated"] }),
      text: z.string().nullable().describe("The translation; null unless translated").meta({ examples: ["Danke, Sam! Eine Lösung ist unterwegs."] }),
      language: z.string().nullable().describe("The user's language (a BCP 47 code); null when not_translated").meta({ examples: ["de"] }),
      error: z.string().nullable().describe("Why it failed; null unless failed").meta({ examples: [null] }),
    })
    .describe("The reply's translation"),
  run: async ({ projectId }, input) => {
    const conversation = await findConversation(projectId, input.number);
    const translation = await replyTranslation(projectId, conversation.id, input.body);
    if (!translation || "outdated" in translation) {
      return { status: "not_translated" as const, text: null, language: null, error: null };
    }
    return "error" in translation
      ? { status: "failed" as const, text: null, language: translation.language, error: translation.error }
      : { status: "translated" as const, text: translation.text, language: translation.language, error: null };
  },
});

export const retryTranslation = defineOperation({
  name: "conversations.retryTranslation",
  title: "Retry failed translations",
  summary:
    "Where the project translates conversations: the user's messages whose translation failed (their `translationError`) are translated again, in the background. Their translation shows on the conversation once it's in. With none that failed, nothing happens.",
  method: "POST",
  path: "/conversations/{number}/translation-retries",
  scope: "write",
  access: "team",
  errors: [409, 503],
  input: z.object({ number: conversationNumber }),
  example: { number: 12 },
  output: z
    .object({ retried: z.number().int().describe("How many messages are being translated again").meta({ examples: [1] }) })
    .describe("What's being translated again"),
  run: async ({ projectId }, input) => {
    const conversation = await findConversation(projectId, input.number);
    const failed = await prisma.conversationMessage.findMany({
      where: { conversationId: conversation.id, author: "USER", note: false, teamText: null, translationError: { not: null } },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      select: { id: true, translationError: true },
    });
    if (failed.length === 0) {
      return { retried: 0 };
    }
    if (!(await translationSettings(projectId)).translate) {
      throw new OperationError(409, "translation_off", "This project doesn't translate conversations");
    }
    if (!aiEnabled()) {
      throw new OperationError(503, "ai_unavailable", "AI isn't set up on this server, so conversations can't be translated");
    }
    let retried = 0;
    // One at a time, as each arrived: the job settles the conversation's language by the newest.
    for (const { id, translationError } of failed) {
      // Claimed by clearing why it failed: a second Try again meanwhile finds nothing to queue (no second paid translation),
      // and the job sets it again if this one fails too.
      const { count } = await prisma.conversationMessage.updateMany({ where: { id, teamText: null, translationError: { not: null } }, data: { translationError: null } });
      if (count === 0) {
        continue;
      }
      retried++;
      await enqueue("translateMessage", { messageId: id }).catch(async (error: unknown) => {
        // Not queued: it shows its Try again again.
        await translationFailed(id, translationError!);
        throw error;
      });
    }
    if (retried > 0) {
      // Open Inbox pages (other teammates' too) refresh, so the old failure goes; only the clicking page says "Translating…" (it knows what it re-queued).
      await notifyInboxNow({ projectId, conversationId: conversation.id, number: conversation.number, userId: conversation.userId, visitorHash: conversation.visitorHash, email: conversation.email });
    }
    return { retried };
  },
});

export const updateConversation = defineOperation({
  name: "conversations.update",
  title: "Update a conversation",
  summary:
    "Change a conversation's status or assignee, mark it spam or priority, take it over from the AI or hand it back, or snooze it: out of the inbox's views till then, or till the user writes. Closed and spam ones aren't snoozed (409). Marking spam or not teaches the spam filter about its sender.",
  method: "PATCH",
  path: "/conversations/{number}",
  scope: "write",
  access: "team",
  errors: [409],
  input: z
    .object({
      number: conversationNumber,
      status: z
        .enum(CONVERSATION_STATUSES)
        .optional()
        .describe("Its new status: waiting (on the user) only once the team's reply is its latest message (replying sets it)")
        .meta({ examples: ["closed"] }),
      assignee: z.email().nullable().optional().describe("Assign it to a team member, by their email; null to unassign").meta({ examples: ["olive@example.com"] }),
      spam: z
        .boolean()
        .optional()
        .describe(
          "Mark it as spam, or not. Where its sender's address is proven (not mail that failed DMARC, nor an address a signed-out visitor typed or the API gave), their next conversation is filed the same way. false on one the spam filter filed (`spamReason`) tells the team and webhooks (`conversation.created`), as a new conversation",
        )
        .meta({ examples: [true] }),
      blockDomain: z
        .boolean()
        .optional()
        .describe(
          "With `spam: true`: also block the sender's domain (their organisation's, its subdomains too), so new conversations from it go to Spam, but for senders an owner or admin marked not spam. Owners and admins only (403). Refused (409 `no_domain`) for a domain anyone can get an address at (gmail.com), and where the sender's address isn't proven",
        )
        .meta({ examples: [false] }),
      handledBy: z
        .enum(HANDLERS)
        .optional()
        .describe("Who has it: team takes it over from the AI (Take over; a teammate's reply does too), ai hands it back to the AI, out of the team's views, emails and notifications. Nothing answers for the AI yet: one handed to it waits in With AI, and the team isn't told, till a teammate takes it over. Closing and reopening leave it")
        .meta({ examples: ["team"] }),
      priority: z.boolean().optional().describe("Mark it priority, or not").meta({ examples: [true] }),
      snoozedUntil: z.iso
        .datetime({ offset: true })
        .transform((at) => new Date(at))
        .refine((at) => at > new Date() && at.getTime() - Date.now() <= 366 * 86_400_000, "Snooze it till a time in the next year")
        .nullable()
        .optional()
        .describe("Snooze it till a time to come, up to a year; null wakes it")
        .meta({ examples: ["2026-11-25T09:00:00.000Z"] }),
    })
    .refine(
      (input) => [input.status, input.assignee, input.spam, input.handledBy, input.priority, input.snoozedUntil].some((value) => value !== undefined),
      "Send a status, an assignee, spam, handledBy, priority or snoozedUntil",
    )
    .refine((input) => !input.blockDomain || input.spam === true, "blockDomain goes with spam: true")
    .meta({ anyOf: ["status", "assignee", "spam", "handledBy", "priority", "snoozedUntil"].map((field) => ({ required: [field] })) }),
  example: { status: "closed" },
  output: z
    .object({
      ...conversationFields,
      notice: z
        .string()
        .optional()
        .describe(
          "With `spam: false`: what it leaves in place, when something stays that would file this sender again (a blocked address or domain and who can change it, the hourly limit, DMARC), or what it undid (a blocked address an owner or admin took off the list)",
        )
        .meta({ examples: ["spam.example stays blocked. e2e-kim@spam.example is let through from now on."] }),
    })
    .describe("The conversation as it is now"),
  run: async ({ actor, projectId }, input) => {
    const conversation = await findConversation(projectId, input.number);
    const assigneeId = input.assignee ? await teamMemberByEmail(projectId, input.assignee) : input.assignee;
    let notice: string | undefined;
    // The spam filter had filed it and a teammate says it isn't spam: told as a new conversation, once (its reason goes).
    let released = false;
    // Marked Not spam: what its user wrote while it was in Spam, when nobody was told, oldest first.
    let unheard: MessageRow[] = [];
    const updated = await prisma.$transaction(async (tx) => {
      // The row as it is now, held till this commits: what's decided on it isn't undone by a change in between (a close,
      // a reply, spam). NO KEY: a message being added (its foreign key's share lock) doesn't wait for it, nor it for that.
      const [held] = await tx.$queryRaw<{ status: ConversationStatus; spam: boolean; snoozedUntil: Date | null; spamReason: string | null; spamMarkedAt: Date | null }[]>`
        SELECT "status", "spam", "snoozedUntil", "spamReason", "spamMarkedAt" FROM "conversation" WHERE "id" = ${conversation.id} FOR NO KEY UPDATE`;
      // A closed one, or spam, is done with: nothing to snooze (open it first, or in the same change).
      if (input.snoozedUntil && (input.status ?? toApiStatus(held!.status)) === "closed") {
        throw new OperationError(409, "closed", "A closed conversation isn't snoozed");
      }
      if (input.snoozedUntil && (input.spam ?? held!.spam)) {
        throw new OperationError(409, "spam", "Spam isn't snoozed");
      }
      // Waiting on the user is the team having spoken last (a reply kept open, its follow-up answered, is set so by hand).
      // Read after the hold: a message being added holds the row first, so it's written by now, or waits for this.
      if (input.status === "waiting") {
        const [latest] = await tx.$queryRaw<{ author: string }[]>`
          SELECT "author" FROM "conversation_message" WHERE "conversationId" = ${conversation.id} AND NOT "note"
          ORDER BY "createdAt" DESC, "id" DESC LIMIT 1`;
        if (latest?.author !== "TEAM") {
          throw new OperationError(409, "unanswered", "They wrote last: reply, and it waits on them");
        }
      }
      // A teammate's decision (the mark changes): kept on the conversation and, where it applies, about its sender.
      const marked = input.spam !== undefined && input.spam !== held!.spam;
      let markedAt = new Date();
      if (marked || input.blockDomain) {
        const member = await tx.teamMember.findFirst({ where: { projectId, userId: teamMemberId(actor) }, select: { role: true } });
        const admin = !!member && isAdminRole(member.role);
        const sent = { ...conversation, projectId };
        if (marked) {
          notice = await recordMark(tx, sent, input.spam!, admin, held!.spamReason);
          released = !input.spam && !!held!.spamReason;
          // Read while it's held: a message waits for this, sees it unmarked and tells of itself. Since the filter filed it
          // (all of it), or since its mark; one marked before marks had a time has none to count from, and nothing is told.
          // ponytail: the first 100.
          if (!input.spam && (released || held!.spamMarkedAt)) {
            unheard = await tx.conversationMessage.findMany({
              where: { conversationId: conversation.id, author: "USER", note: false, ...(!released && { createdAt: { gt: held!.spamMarkedAt! } }) },
              orderBy: [{ createdAt: "asc" }, { id: "asc" }],
              take: 100,
              select: messageSelect,
            });
          }
          // Marked as spam no earlier than its latest message, whichever server's clock runs ahead: only what's written
          // after is told on Not spam (addMessage times those after the mark).
          if (input.spam) {
            const [{ latest }] = await tx.$queryRaw<[{ latest: Date | null }]>`
              SELECT MAX("createdAt") AS latest FROM "conversation_message" WHERE "conversationId" = ${conversation.id}`;
            markedAt = new Date(Math.max(markedAt.getTime(), latest?.getTime() ?? 0));
          }
        }
        if (input.blockDomain) {
          await blockDomainOf(tx, sent, admin);
        }
      }
      // Woken by hand, as when its time passes: open again (unless it's being closed, or is or becomes spam). A snooze
      // whose time has just passed too, before the wake job got to it: clearing it here, it would never open otherwise.
      const waking = input.snoozedUntil === null && !!held?.snoozedUntil && !input.status && !(input.spam ?? held.spam) && held.status !== "CLOSED";
      const row = await tx.conversation.update({
        where: { id: conversation.id },
        data: {
          ...(input.status && { status: input.status.toUpperCase() as ConversationStatus }),
          ...(input.status === "waiting" && { waitingSince: null }),
          ...(waking && { status: "OPEN" as const }),
          // Closed, opened, spam or not: how old it is for a plan's history starts again (not for an assignee or a snooze).
          ...((input.status !== undefined || input.spam !== undefined || waking) && { activeAt: new Date() }),
          // Assigned or unassigned by the team: no longer the imported holder's to take over (handOverPlaceholders).
          ...(assigneeId !== undefined && { assigneeId, heldById: null }),
          ...(input.spam !== undefined && { spam: input.spam }),
          ...(marked && { spamMarkedAt: markedAt, spamReason: null }),
          // Take over, or Hand back to the AI: nothing else about it moves (its status, its assignee, how old it is).
          ...(input.handledBy && { handledBy: input.handledBy.toUpperCase() as ConversationOwner }),
          ...(input.priority !== undefined && { priority: input.priority }),
          ...(input.snoozedUntil !== undefined && { snoozedUntil: input.snoozedUntil, snoozedAt: input.snoozedUntil && new Date() }),
          // Closed or spam is done with: a snooze no longer brings it back.
          ...((input.status === "closed" || input.spam === true) && input.snoozedUntil === undefined && { snoozedUntil: null }),
          // One left on it while it was closed or spam (by a release from before) doesn't come back with it.
          ...((held!.status === "CLOSED" || held!.spam) && input.snoozedUntil === undefined && { snoozedUntil: null }),
        },
        select: { ...conversationSelect, userId: true, visitorHash: true },
      });
      await notifyInbox(tx, { projectId, conversationId: row.id, number: row.number, userId: row.userId, visitorHash: row.visitorHash, email: row.email });
      return row;
    });
    // It's unmarked whatever happens here, and saying it again would tell nobody: a failure is logged, not thrown.
    try {
      // Filed by the filter: its first message is the new conversation's, told to the team too. The rest, to webhooks.
      const first = released ? unheard.shift() : undefined;
      if (first) {
        await announceConversation(projectId, updated, first);
      }
      for (const message of unheard) {
        await emitEvent(projectId, "conversation.message_created", { conversation: updated.number, message: messageView(message) });
      }
    } catch (error) {
      log.error("Announcing a conversation that isn't spam after all failed", { projectId, error });
    }
    return { ...view(updated, await projectSlug(projectId)), ...(notice && { notice }) };
  },
});

/** The posts a conversation is linked to, the first linked first. */
async function linkedPosts(conversationId: string) {
  const links = await prisma.conversationPost.findMany({
    where: { conversationId },
    orderBy: { createdAt: "asc" },
    select: { post: { select: { number: true, title: true, status: true } } },
  });
  return links.map(({ post }) => ({ number: post.number, title: post.title, status: toPostStatus(post.status) }));
}

export const linkConversationPost = defineOperation({
  name: "conversations.linkPost",
  title: "Link a conversation to a post",
  summary: "Link a conversation to a post it's about; merging the post takes the link along. A merged post isn't linked (409): link the one it was merged into.",
  method: "POST",
  path: "/conversations/{number}/posts",
  scope: "write",
  access: "team",
  errors: [409],
  input: z.object({ number: conversationNumber, post: linkedPost }),
  example: { post: 12 },
  output: linkedPostsOutput,
  run: async ({ projectId }, input) => {
    const conversation = await findConversation(projectId, input.number);
    let post = await findPost(projectId, input.post);
    if (!post.duplicateOf) {
      // Only while it isn't merged: a merge locks its row first (mergePosts), so a link either lands before it
      // (and the merge moves it) or waits for it and finds it merged.
      const linked = await prisma.$executeRaw`
        INSERT INTO conversation_post ("conversationId", "postId")
        SELECT ${conversation.id}, id FROM post WHERE id = ${post.id} AND "duplicateOfId" IS NULL FOR SHARE
        ON CONFLICT ("conversationId", "postId") DO NOTHING`;
      if (linked === 0) {
        post = await findPost(projectId, input.post);
      }
    }
    if (post.duplicateOf) {
      throw new OperationError(409, "merged", `#${post.number} was merged into #${post.duplicateOf.number}: link that one`);
    }
    return { posts: await linkedPosts(conversation.id) };
  },
});

export const unlinkConversationPost = defineOperation({
  name: "conversations.unlinkPost",
  title: "Unlink a conversation's post",
  summary: "Unlink a conversation from a post",
  method: "DELETE",
  path: "/conversations/{number}/posts/{post}",
  scope: "write",
  access: "team",
  input: z.object({ number: conversationNumber, post: linkedPost }),
  output: linkedPostsOutput,
  run: async ({ projectId }, input) => {
    const conversation = await findConversation(projectId, input.number);
    // Waits for a merge of the post (which holds its row), so a link it moves isn't unlinked halfway.
    await prisma.$executeRaw`
      DELETE FROM conversation_post WHERE "conversationId" = ${conversation.id}
        AND "postId" = (SELECT id FROM post WHERE "projectId" = ${projectId} AND number = ${input.post} FOR SHARE)`;
    return { posts: await linkedPosts(conversation.id) };
  },
});
