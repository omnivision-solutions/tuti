import { PostStatus, prisma } from "@tuti/db";
import { historySince, visibleConversations } from "@tuti/jobs";
import { z } from "zod";

import { firstLine } from "@/lib/format";
import { formatProperty, propertyHeadings, storedPropertyFormats } from "@/lib/property-formats";

import {
  conversationNumber,
  conversationPerson,
  CONVERSATION_STATUSES,
  findConversation,
  type InboxView,
  inInboxView,
  latestMessages,
  toApiStatus,
} from "./conversations";
import { defineOperation } from "./define";
import { STATUSES as POST_STATUSES, toApiStatus as toPostStatus } from "./read";
import { viewsOf } from "./users";

/** Beside a conversation; their own page lists them all (up to 500). */
const SHOWN = 5;

/**
 * One of the project's users with this address, as a hint for the team: someone writing signed out
 * may be them, or may only have typed their address, so it's never linked and the visitor sees
 * nothing of theirs. Someone from the project's app, else an account with that address verified
 * that has posted, voted or commented here (never just any account, which would tell the team who
 * has one).
 */
async function maybeUser(projectId: string, email: string) {
  const sso = await prisma.ssoIdentity.findFirst({
    // Case-insensitive: emails older instances saved kept their capitals.
    where: { projectId, email: { equals: email, mode: "insensitive" } },
    orderBy: { updatedAt: "desc" },
    select: { externalId: true, user: { select: { name: true } } },
  });
  if (sso) {
    return { name: sso.user.name, id: sso.externalId };
  }
  const account = await prisma.user.findFirst({
    where: {
      email: { equals: email, mode: "insensitive" },
      emailVerified: true,
      ssoIdentity: null,
      OR: [{ posts: { some: { projectId } } }, { votes: { some: { projectId } } }, { comments: { some: { projectId } } }],
    },
    select: { name: true },
  });
  return account && { name: account.name, id: null };
}

/**
 * Someone Tuti knows (their account; with `accounts`, every account that is them, theirs first, as Users counts them),
 * or only their address (verified or not), with the name its email came from.
 */
export type Person = { userId: string | null; email: string | null; name?: string | null; emailVerified: boolean; accounts?: string[] };

/**
 * What the person panel shows of someone (PersonPanel, and conversations.person for Tuti's app): who they are, their
 * properties and groups, posts and votes, and their other conversations. `besides`: the conversation it's beside, left
 * out of theirs. `all`: on their own page, all of each (up to 500), without the conversations' latest messages.
 */
export async function personDetails(projectId: string, person: Person, { besides, all = false }: { besides?: number; all?: boolean } = {}) {
  // ponytail: all of them up to 500 on their own page (the count says how many), pages of them if anyone has more.
  const take = all ? 500 : SHOWN;
  const { userId, email } = person;
  const accounts = userId ? (person.accounts ?? [userId]) : [];
  // Theirs: with one of their accounts, or (known or not) started by email from their address, verified. Not spam, nor
  // past the plan's history. Nobody's with neither (an anonymous contact an import brought in): none is theirs.
  const theirs = {
    projectId,
    spam: false,
    AND: [visibleConversations(await historySince(projectId))],
    ...(besides !== undefined && { number: { not: besides } }),
    OR: [
      ...(accounts.length > 0 ? [{ userId: { in: accounts } }] : email ? [{ userId: null, email }] : []),
      ...(accounts.length > 0 && email && person.emailVerified ? [{ userId: null, emailVerified: true, email }] : []),
    ],
  };
  const [user, groups, others, otherCount, { propertyFormats }] = await Promise.all([
    userId
      ? prisma.user.findUnique({
          where: { id: userId },
          select: {
            name: true,
            email: true,
            emailVerified: true,
            image: true,
            deletedAt: true,
            ssoIdentity: { select: { externalId: true, email: true, properties: true, createdAt: true, updatedAt: true } },
          },
        })
      : null,
    prisma.readerGroup.findMany({ where: { projectId }, select: { key: true, name: true } }),
    prisma.conversation.findMany({
      where: theirs,
      orderBy: { lastMessageAt: "desc" },
      take,
      select: { id: true, number: true, subject: true, status: true, lastMessageAt: true },
    }),
    prisma.conversation.count({ where: theirs }),
    prisma.project.findUniqueOrThrow({ where: { id: projectId }, select: { propertyFormats: true } }),
  ]);
  const formats = storedPropertyFormats(propertyFormats);
  const otherMessages: Map<string, { body: string }> = all ? new Map() : await latestMessages(others.map((c) => c.id));
  const lookalike = !userId && email ? await maybeUser(projectId, email) : null;
  const sso = user?.ssoIdentity;
  const view = sso && user ? (await viewsOf(projectId, [{ ...sso, user: { name: user.name, image: user.image } }]))[0]! : null;
  const [posts, postCount, votes, voteCount] = userId
    ? await Promise.all([
        prisma.post.findMany({
          where: { projectId, authorId: { in: accounts }, duplicateOfId: null },
          orderBy: { createdAt: "desc" },
          take,
          select: { number: true, title: true, status: true },
        }),
        prisma.post.count({ where: { projectId, authorId: { in: accounts }, duplicateOfId: null } }),
        // Votes on others' posts: everyone votes for their own.
        prisma.vote.findMany({
          where: { projectId, userId: { in: accounts }, post: { authorId: { notIn: accounts }, duplicateOfId: null } },
          orderBy: { createdAt: "desc" },
          take,
          select: { post: { select: { number: true, title: true, status: true } } },
        }),
        prisma.vote.count({ where: { projectId, userId: { in: accounts }, post: { authorId: { notIn: accounts }, duplicateOfId: null } } }),
      ])
    : [[], 0, [], 0];
  const groupNames = new Map(groups.map((g) => [g.key, g.name]));
  const headings = propertyHeadings(formats, Object.keys(view?.properties ?? {}));
  // A deleted user (users.delete) has only a placeholder address.
  const shownEmail = sso ? sso.email : user?.deletedAt ? null : (user?.email ?? email);
  const verified = sso ? true : user ? user.emailVerified : person.emailVerified;
  // They marked an email from the project as spam (SES's complaint): replies aren't emailed to that address any more.
  const blocked = shownEmail
    ? await prisma.emailBlock.findUnique({ where: { projectId_email: { projectId, email: shownEmail.toLowerCase() } }, select: { email: true } })
    : null;
  return {
    user,
    name: user?.name ?? person.name ?? null,
    view,
    groupNames,
    formats,
    headings,
    shownEmail,
    verified,
    blocked: !!blocked,
    lookalike,
    others,
    otherCount,
    otherMessages,
    posts,
    postCount,
    votes: votes.map((v) => v.post),
    voteCount,
  };
}

const postOutput = z.object({
  number: z.number().int().describe("The post's number").meta({ examples: [7] }),
  title: z.string().describe("Its title").meta({ examples: ["Export to CSV"] }),
  status: z.enum(POST_STATUSES).describe("Where it is on the roadmap").meta({ examples: ["planned"] }),
});

export const getConversationPerson = defineOperation({
  name: "conversations.person",
  title: "Get who it's with",
  summary:
    "Get who a conversation is with, as the panel beside it in Tuti's app shows them: who they are, their properties and groups, their latest 5 posts, votes and other conversations, with how many of each.",
  method: "GET",
  path: "/conversations/{number}/person",
  scope: "read",
  access: "team",
  input: z.object({ number: conversationNumber }),
  output: z
    .object({
      id: z.string().nullable().describe("Their id in your app, when they came through SSO or the API; null otherwise").meta({ examples: ["user-42"] }),
      name: z
        .string()
        .nullable()
        .describe("Their name; for someone known by email only, the name their email came from, once its address is verified. Null when there's none: show their email")
        .meta({ examples: ["Sam Lee"] }),
      email: z.string().nullable().describe("Their email address; null for a deleted user, or someone from your app who hasn't given one").meta({ examples: ["sam@example.com"] }),
      verified: z.boolean().describe("Whether the address is known to be theirs; else the app says it's not verified").meta({ examples: [true] }),
      account: z
        .boolean()
        .describe("Whether they have an account here (from your app, or the portal); false: known only by this address, and they have no posts or votes")
        .meta({ examples: [true] }),
      blocked: z.boolean().describe("They marked your email as spam, so replies aren't emailed to them any more").meta({ examples: [false] }),
      maybe: z
        .object({
          name: z.string().describe("Their name").meta({ examples: ["Sam Lee"] }),
          id: z.string().nullable().describe("Their id in your app; null for a portal account").meta({ examples: ["user-42"] }),
        })
        .nullable()
        .describe("Someone writing without an account: one of your users with this address, who they may be (not signed in, so never theirs to see)"),
      properties: z
        .array(
          z.object({
            key: z.string().describe("The property's name, as your app sends it").meta({ examples: ["mrr"] }),
            label: z.string().describe("Its name as the team calls it (project.update's `propertyFormats`), else its key in words").meta({ examples: ["MRR"] }),
            value: z
              .union([z.string(), z.number(), z.boolean(), z.array(z.string())])
              .describe("Its value, as your app sent it")
              .meta({ examples: [1200] }),
            text: z.string().describe("Its value as the team formats it: numbers, money and dates, as Tuti's app shows it").meta({ examples: ["$1,200"] }),
          }),
        )
        .describe("What your app tells Tuti about them, in the order it's stored; empty without SSO"),
      groups: z
        .array(
          z.object({
            key: z.string().describe("The reader group's key").meta({ examples: ["enterprise"] }),
            name: z.string().describe("Its name").meta({ examples: ["Enterprise"] }),
          }),
        )
        .describe("The reader groups they're in now"),
      posts: z.array(postOutput).describe("Their latest 5 posts, newest first (merged ones left out)"),
      postCount: z.number().int().describe("How many posts they have").meta({ examples: [3] }),
      votes: z.array(postOutput).describe("The latest 5 posts they voted on, newest vote first; never their own"),
      voteCount: z.number().int().describe("How many others' posts they voted on").meta({ examples: [8] }),
      conversations: z
        .array(
          z.object({
            number: z.number().int().describe("The conversation's number").meta({ examples: [9] }),
            subject: z.string().describe("Its subject").meta({ examples: ["Invoices"] }),
            status: z.enum(CONVERSATION_STATUSES).describe("open, waiting or closed").meta({ examples: ["closed"] }),
            lastMessageAt: z.string().describe("When its latest message was written (ISO 8601)").meta({ examples: ["2026-11-18T09:30:00.000Z"] }),
            line: z.string().nullable().describe("Its latest message's first line (never a note), up to 140 characters").meta({ examples: ["Where do I find last month's invoice?"] }),
          }),
        )
        .describe("Their latest 5 other conversations, newest first: not this one, nor spam"),
      conversationCount: z.number().int().describe("How many other conversations they have").meta({ examples: [2] }),
    })
    .describe("Who the conversation is with"),
  run: async ({ projectId }, { number }) => {
    const conversation = await findConversation(projectId, number);
    const details = await personDetails(projectId, { ...conversation, name: conversationPerson(conversation).name }, { besides: number });
    const { user, view, formats, headings } = details;
    return {
      id: view?.id ?? null,
      name: details.name,
      email: details.shownEmail,
      verified: details.verified,
      account: !!user,
      blocked: details.blocked,
      maybe: details.lookalike,
      properties: Object.entries(view?.properties ?? {}).map(([key, value]) => ({ key, label: headings.get(key)!, value, text: formatProperty(formats, key, value) })),
      groups: (view?.groups ?? []).map((key) => ({ key, name: details.groupNames.get(key) ?? key })),
      posts: details.posts.map((p) => ({ ...p, status: toPostStatus(p.status) })),
      postCount: details.postCount,
      votes: details.votes.map((p) => ({ ...p, status: toPostStatus(p.status) })),
      voteCount: details.voteCount,
      conversations: details.others.map((c) => ({
        number: c.number,
        subject: c.subject,
        status: toApiStatus(c.status),
        lastMessageAt: c.lastMessageAt,
        line: firstLine(details.otherMessages.get(c.id)?.body ?? "") ?? null,
      })),
      conversationCount: details.otherCount,
    };
  },
});

/**
 * What the person panel shows (PersonPanel), as plain data: personDetails with its properties formatted, its groups
 * named and each other conversation's latest line. `inbox`: beside a conversation in the Inbox, which of their other
 * conversations are in its list (the view, or a search's results) for the teammate looking: those open beside it there.
 * The Users page builds it here too until it reads through the router (T9b).
 */
export async function personPanel(
  projectId: string,
  person: Person,
  { besides, all = false, inbox }: { besides?: number; all?: boolean; inbox?: { userId: string; view: InboxView; q: string } } = {},
) {
  const details = await personDetails(projectId, person, { besides, all });
  const { user, view, formats, headings } = details;
  const inView = inbox ? await inInboxView(projectId, inbox.userId, inbox.view, details.others.map((c) => c.id), inbox.q) : new Set<number>();
  return {
    account: !!user,
    id: view?.id ?? null,
    name: details.name,
    email: details.shownEmail,
    verified: details.verified,
    blocked: details.blocked,
    maybe: details.lookalike,
    properties: Object.entries(view?.properties ?? {}).map(([key, value]) => ({ key, label: headings.get(key)!, text: formatProperty(formats, key, value) })),
    groups: (view?.groups ?? []).map((key) => ({ key, name: details.groupNames.get(key) ?? key })),
    posts: details.posts,
    postCount: details.postCount,
    votes: details.votes,
    voteCount: details.voteCount,
    conversations: details.others.map((c) => ({
      number: c.number,
      subject: c.subject,
      status: c.status,
      lastMessageAt: c.lastMessageAt,
      line: firstLine(details.otherMessages.get(c.id)?.body ?? "") ?? null,
      inView: inView.has(c.number),
    })),
    conversationCount: details.otherCount,
  };
}

export type PersonPanelData = Awaited<ReturnType<typeof personPanel>>;

const panelPost = z.object({ number: z.number().int(), title: z.string(), status: z.enum(Object.values(PostStatus) as [PostStatus, ...PostStatus[]]) });

/** personPanel's output, for inbox.conversation's `person`. */
export const personPanelOutput = z.object({
  account: z.boolean(),
  id: z.string().nullable(),
  name: z.string().nullable(),
  email: z.string().nullable(),
  verified: z.boolean(),
  blocked: z.boolean(),
  maybe: z.object({ name: z.string(), id: z.string().nullable() }).nullable(),
  properties: z.array(z.object({ key: z.string(), label: z.string(), text: z.string() })),
  groups: z.array(z.object({ key: z.string(), name: z.string() })),
  posts: z.array(panelPost),
  postCount: z.number().int(),
  votes: z.array(panelPost),
  voteCount: z.number().int(),
  conversations: z.array(
    z.object({ number: z.number().int(), subject: z.string(), status: z.enum(["OPEN", "WAITING", "CLOSED"]), lastMessageAt: z.string(), line: z.string().nullable(), inView: z.boolean() }),
  ),
  conversationCount: z.number().int(),
});
