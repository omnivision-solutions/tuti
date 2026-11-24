import { type ConversationOrigin, type ConversationStatus, type MessageAuthor, type MessageChannel, type Prisma, prisma } from "@tuti/db";
import { enqueue, historySince, inSomePlansHistory, visibleConversations } from "@tuti/jobs";
import { log } from "@tuti/shared";
import { z } from "zod";

import { subjectFrom } from "@/lib/format";
import { appUrl } from "@/lib/hosts";

import { attachmentLinks, checkUploads, claimUploads } from "../attachments";
import { emitEvent } from "../events";
import { notifyInbox } from "../live";
import { namedProjectUser } from "../project-users";
import { type Actor, defineOperation, OperationError } from "./define";
import { findPost, postNumber, projectSlug, STATUSES as POST_STATUSES, toApiStatus as toPostStatus } from "./read";

/** The support inbox (docs/plan.md, Support inbox): conversations between a project's users and its team. */

export const CONVERSATION_STATUSES = ["open", "waiting", "closed"] as const;
const toApiStatus = (status: ConversationStatus) => status.toLowerCase() as (typeof CONVERSATION_STATUSES)[number];

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
  lastMessageAt: at("When its latest message was written; notes don't move it"),
  waitingSince: at("Since when the user has waited on the team: their oldest unanswered message; null when they aren't waiting").nullable(),
  snoozedUntil: at("Out of the inbox's views till then, or till the user writes; null when not snoozed (closed and spam ones never are)")
    .nullable()
    .meta({ examples: [null] }),
  createdAt: at("When it started"),
  url: z.string().describe("Its page in Tuti's inbox").meta({ examples: ["https://tuti.example.com/app/acme/inbox/12"] }),
};

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
    select: { ...conversationSelect, userId: true },
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

/** The team member writing: the signed-in one, or for an API key, the one who created it. */
const teamMemberId = (actor: Actor) => (actor.kind === "user" ? actor.userId : actor.createdById);

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
      { messages: { some: { projectId, body: has } } },
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
          SELECT id, author, note, "createdAt", body, length(body) AS length, greatest(position(lower(${q}) IN lower(body)) - ${SNIPPET_LEAD}, 1) AS "from"
          FROM conversation_message
          WHERE "conversationId" = c.id AND body ILIKE ${`%${likeText(q)}%`} ORDER BY "createdAt" DESC, id DESC LIMIT 1
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
  summary: "List conversations, latest message first, a page at a time, or search them with `q`. Spam is left out unless asked for.",
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
              match: matchOutput
                .nullable()
                .describe("With `q`: the newest message or note with the text; null when none has it (its number, subject or person does), and without `q`"),
            })
            .meta({ id: "Conversation", description: "A conversation between someone and the team; in a search, with the message it was found by" }),
        )
        .describe("The conversations, latest message first"),
      nextCursor: z.string().nullable().describe("The next page's `cursor`; null on the last page").meta({ examples: ["25"] }),
    })
    .describe("A page of conversations"),
  example: { status: "open", assignee: "none", limit: 10 },
  run: async ({ projectId }, input) => {
    const assigneeId =
      input.assignee === undefined || input.assignee === "none" ? null : await teamMemberByEmail(projectId, input.assignee);
    // ponytail: offset cursors, like posts.list.
    const rows = await prisma.conversation.findMany({
      where: {
        projectId,
        spam: input.spam,
        ...(input.status && { status: input.status.toUpperCase() as ConversationStatus }),
        ...(input.assignee !== undefined && { assigneeId }),
        ...(input.user && { user: { ssoIdentity: { projectId, externalId: input.user } } }),
        // With the status asked for, if any (each a condition of its own, so neither takes the other's place). Not those
        // past the plan's history.
        AND: [
          visibleConversations(await historySince(projectId)),
          ...(input.q ? [await conversationsMatching(projectId, input.q)] : []),
          ...(input.snoozed === true ? [{ snoozedUntil: { gt: new Date() } }, { status: { not: "CLOSED" as const } }, { spam: false }] : []),
          ...(input.snoozed === false ? [awake()] : []),
        ],
      },
      orderBy: [{ lastMessageAt: "desc" }, { number: "desc" }],
      skip: input.cursor,
      take: input.limit + 1,
      select: conversationSelect,
    });
    const slug = await projectSlug(projectId);
    const page = rows.slice(0, input.limit);
    const matches = input.q ? await matchedMessages(page.map((row) => row.id), input.q) : null;
    return {
      conversations: page.map((row) => ({ ...view(row, slug), match: matches?.get(row.id) ?? null })),
      nextCursor: rows.length > input.limit ? String(input.cursor + input.limit) : null,
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
      posts: z.array(linkedPostOutput).describe("The posts it's linked to, the first linked first"),
      messages: z.array(messageOutput).describe("Its messages and notes, oldest first"),
    })
    .describe("The conversation"),
  run: async ({ projectId }, { number }) => {
    const conversation = await findConversation(projectId, number);
    const messages = await prisma.conversationMessage.findMany({
      where: { conversationId: conversation.id },
      orderBy: { createdAt: "asc" },
      select: messageSelect,
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
    return {
      ...view(conversation, await projectSlug(projectId)),
      posts: await linkedPosts(conversation.id),
      messages: messages.map((message) => {
        const shown = messageView(message);
        return { ...shown, attachments: shown.attachments.map((a) => ({ ...a, url: links.get(a.id) ?? null })) };
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

/** Emails the team about the user's message (packages/jobs, conversation-message); never fails or holds up the request. */
async function tellTeam(messageId: string) {
  try {
    await enqueue("conversationMessage", { messageId });
  } catch (error) {
    // The message is saved: the conversation-notices-resubmit cron finds it and queues it again.
    log.error("Enqueueing the team's email about a message failed", { error, messageId });
  }
}

/** A new conversation as the API shows it, told to the project's webhooks and team. */
export async function announceConversation(projectId: string, conversation: ConversationRow, message: MessageRow) {
  const result = { ...view(conversation, await projectSlug(projectId)), messages: [messageView(message)] };
  await emitEvent(projectId, "conversation.created", result);
  await tellTeam(message.id);
  return result;
}

/** A message from the user, told to the project's webhooks and team (the team's own replies aren't, so they don't echo back). */
export async function announceUserMessage(projectId: string, number: number, message: MessageRow) {
  const result = messageView(message);
  await emitEvent(projectId, "conversation.message_created", { conversation: number, message: result });
  await tellTeam(message.id);
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
    /** Mail that failed DMARC: it goes to Spam, and nobody is told. */
    spam?: boolean;
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
        spam: start.spam ?? false,
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
    await notifyInbox(tx, { projectId, conversationId: conversation.id, userId: start.userId, visitorHash: start.visitorHash ?? null, email: conversation.email });
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
  message: { author: "USER" | "TEAM" | "AI"; authorId: string | null; channel: "API" | "APP" | "WIDGET" | "EMAIL"; body: string; note?: boolean } & Partial<ReceivedEmail>,
  /** More to write in the same transaction (a received email's status), with the new message's id. */
  alongside?: (tx: Prisma.TransactionClient, messageId: string) => Promise<void>,
  /**
   * The team's reply closes it (Send and close), in the same transaction, rather than leaving it waiting on the user; `seen`,
   * the latest message the team saw: one from the user after it (that no teammate has answered since) keeps it open and
   * waiting on the team. `outcome` says what this reply did (not what someone else did after it): closed it, or kept it open.
   */
  { close = false, seen, outcome }: { close?: boolean; seen?: Date; outcome?: { closed?: boolean; keptOpen?: boolean } } = {},
) {
  return prisma.$transaction(async (tx) => {
    // Every message holds the conversation first, then takes its time: after the conversation's latest (by a millisecond
    // when the clock says no later, or another server's clock runs ahead), so messages' times are the order they're
    // written in. A user message is never older than a reply or note the team has already seen.
    // (The latest read in a statement of its own, after the wait: one written by whoever held it is seen.)
    await tx.$executeRaw`SELECT 1 FROM "conversation" WHERE "id" = ${conversationId} FOR NO KEY UPDATE`;
    const [{ latest }] = await tx.$queryRaw<[{ latest: Date | null }]>`
      SELECT MAX("createdAt") AS latest FROM "conversation_message" WHERE "conversationId" = ${conversationId}`;
    const now = new Date(Math.max(Date.now(), latest ? latest.getTime() + 1 : 0));
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
    const whose = await tx.conversation.findUniqueOrThrow({ where: { id: conversationId }, select: { userId: true, visitorHash: true, email: true } });
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
      const [held] = await tx.$queryRaw<[{ status: ConversationStatus }]>`SELECT "status" FROM "conversation" WHERE "id" = ${conversationId}`;
      const [{ unseen }] = await tx.$queryRaw<[{ unseen: boolean }]>`
        SELECT EXISTS (SELECT 1 FROM "conversation_message" WHERE "conversationId" = ${conversationId} AND "author" = 'USER'
          AND NOT "note" AND "createdAt" > ${seen ?? now}) AS unseen`;
      const after = held.status === "OPEN" && unseen;
      await tx.$executeRaw`UPDATE "conversation" SET
        "status" = CASE WHEN ${after} THEN "status" ELSE ${close ? "CLOSED" : "WAITING"}::"ConversationStatus" END,
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
  input: z.object({
    number: conversationNumber,
    body,
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
        .describe("A reply's (not a note's or the user's): whether it stays open and waiting on the team, as the user wrote after what the team saw (`seen`), unanswered")
        .meta({ examples: [false] }),
      closed: z.boolean().optional().describe("With `close`: whether it closed the conversation (not when it was kept open)").meta({ examples: [true] }),
    })
    .describe("The message written"),
  run: async ({ actor, projectId }, input) => {
    // Written as its user (an API key's), it joins one past the plan's history, as their email would.
    const conversation = await findConversation(projectId, input.number, { hidden: !!input.author && actor.kind !== "user" });
    let message: MessageRow;
    if (input.note && input.author) {
      throw new OperationError(400, "invalid_input", "Notes are the team's: write one without an author");
    }
    if (input.close && (input.note || input.author)) {
      throw new OperationError(400, "invalid_input", "Only the team's reply closes a conversation");
    }
    if (input.attachments?.length && (input.author || actor.kind !== "user")) {
      throw new OperationError(400, "invalid_input", "Attachments are uploaded and sent by a teammate in the app");
    }
    const uploads = input.attachments?.length && actor.kind === "user" ? await checkUploads(projectId, { userId: actor.userId }, input.attachments) : [];
    const outcome: { closed?: boolean; keptOpen?: boolean } = {};
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
      message = await addMessage(conversation.id, projectId, { author: "USER", authorId: identity.userId, channel: "API", body: input.body });
    } else {
      message = await addMessage(
        conversation.id,
        projectId,
        {
          author: "TEAM",
          authorId: teamMemberId(actor),
          channel: actor.kind === "user" ? "APP" : "API",
          body: input.body,
          note: input.note ?? false,
        },
        uploads.length > 0 ? (tx, messageId) => claimUploads(tx, uploads, messageId) : undefined,
        // Not saying (the API, MCP): what the conversation's latest message was as this reply was asked for, before writing it.
        { close: input.close, seen: input.seen ?? conversation.lastMessageAt, outcome },
      );
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

export const updateConversation = defineOperation({
  name: "conversations.update",
  title: "Update a conversation",
  summary:
    "Change a conversation's status, assign it to a team member, mark it as spam, or snooze it: out of the inbox's views till then, or till the user writes, and open again after. Closed conversations and spam aren't snoozed (409).",
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
      spam: z.boolean().optional().describe("Mark it as spam, or not").meta({ examples: [true] }),
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
      (input) => input.status !== undefined || input.assignee !== undefined || input.spam !== undefined || input.snoozedUntil !== undefined,
      "Send a status, an assignee, spam or snoozedUntil",
    )
    .meta({ anyOf: [{ required: ["status"] }, { required: ["assignee"] }, { required: ["spam"] }, { required: ["snoozedUntil"] }] }),
  example: { status: "closed" },
  output: z.object(conversationFields).describe("The conversation as it is now"),
  run: async ({ projectId }, input) => {
    const conversation = await findConversation(projectId, input.number);
    const assigneeId = input.assignee ? await teamMemberByEmail(projectId, input.assignee) : input.assignee;
    const updated = await prisma.$transaction(async (tx) => {
      // The row as it is now, held till this commits: what's decided on it isn't undone by a change in between (a close,
      // a reply, spam). NO KEY: a message being added (its foreign key's share lock) doesn't wait for it, nor it for that.
      const [held] = await tx.$queryRaw<{ status: ConversationStatus; spam: boolean; snoozedUntil: Date | null }[]>`
        SELECT "status", "spam", "snoozedUntil" FROM "conversation" WHERE "id" = ${conversation.id} FOR NO KEY UPDATE`;
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
          ...(input.snoozedUntil !== undefined && { snoozedUntil: input.snoozedUntil, snoozedAt: input.snoozedUntil && new Date() }),
          // Closed or spam is done with: a snooze no longer brings it back.
          ...((input.status === "closed" || input.spam === true) && input.snoozedUntil === undefined && { snoozedUntil: null }),
          // One left on it while it was closed or spam (by a release from before) doesn't come back with it.
          ...((held!.status === "CLOSED" || held!.spam) && input.snoozedUntil === undefined && { snoozedUntil: null }),
        },
        select: { ...conversationSelect, userId: true, visitorHash: true },
      });
      await notifyInbox(tx, { projectId, conversationId: row.id, userId: row.userId, visitorHash: row.visitorHash, email: row.email });
      return row;
    });
    return view(updated, await projectSlug(projectId));
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
