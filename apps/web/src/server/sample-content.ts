import { randomUUID } from "node:crypto";

import { fromPlainText } from "@tuti/content";
import { type Prisma, prisma } from "@tuti/db";
import { lockProject } from "@tuti/jobs";

import { PROJECT_USE_KEYS } from "@/lib/project-uses";

import { freeDocsSlug, recordRevision, tabFor } from "./operations/docs";

/**
 * Sample content to try things with (docs/plan.md, the redesign's step 6), for what the team picked after
 * "Create project" (all four without picks): posts on the first board with votes, a comment and a status
 * (Feedback), a collection of two articles (Docs), an update (Changelog) and a conversation (Support). Each
 * is marked `sample`: labelled Sample, left out of Home, and removed with removeSampleContent.
 *
 * Written straight to the database, so nothing is emailed, queued (no embeddings, duplicates, Autopilot or
 * webhooks) or counted. Its people are accounts of their own at fixed placeholder addresses (`.invalid`,
 * unverified, like a project's SSO users'), which Tuti never emails, and which removing finds exactly.
 */

const PEOPLE = ["Alex Rivera", "Sam Okafor", "Jordan Lee"];

const personEmail = (projectId: string, n: number) => `sample-${n}-${projectId}@users.tuti.invalid`;

/** Indexes are into PEOPLE: the first voter wrote it. */
const POSTS = [
  {
    title: "Dark mode",
    body: "The dashboard is very bright when I work late. A dark theme would be easier on the eyes.",
    status: "PLANNED" as const,
    voters: [0, 1, 2],
    comment: { by: 1, body: "Yes please! Following the system setting would be perfect." },
  },
  { title: "Export reports to CSV", body: "We'd like to pull our monthly numbers into a spreadsheet.", status: "OPEN" as const, voters: [1, 2] },
  { title: "Slack notifications", body: "Tell our team's channel when something needs us.", status: "OPEN" as const, voters: [2] },
];

const DOCS = {
  name: "Getting started",
  description: "The basics, in five minutes.",
  articles: [
    { title: "Create your account", body: "Sign up with your work email, then confirm it from the email we send you.\n\nThat's it: you're in." },
    { title: "Invite your team", body: "Open Settings, then Team, and enter your teammates' emails.\n\nEach of them gets an email with a link to join." },
  ],
};

const UPDATE = {
  title: "Welcome to our changelog",
  body: "This is where we share what's new: features, improvements and fixes, as they ship.",
};

const CONVERSATION = {
  subject: "Can I export my data?",
  body: "Hi! Is there a way to export everything in my account? We need it for our yearly review.",
};

const sample = (projectId: string) => ({ projectId, sample: true });

/** Adds the sample content for the project's picks, in one transaction; a kind it already has isn't added again. */
export async function addSampleContent(projectId: string, userId: string) {
  await prisma.$transaction(async (tx) => {
    await lockProject(tx, projectId);
    const { uses } = await tx.project.findUniqueOrThrow({ where: { id: projectId }, select: { uses: true } });
    const picked = new Set<string>(uses.length > 0 ? uses : PROJECT_USE_KEYS);
    const now = new Date();
    const content = (body: string) => ({ body, content: fromPlainText(body) as Prisma.InputJsonValue });

    const missing = {
      feedback: picked.has("feedback") && !(await tx.post.findFirst({ where: sample(projectId), select: { id: true } })),
      docs: picked.has("docs") && !(await tx.collection.findFirst({ where: sample(projectId), select: { id: true } })),
      changelog: picked.has("changelog") && !(await tx.changelogEntry.findFirst({ where: sample(projectId), select: { id: true } })),
      support: picked.has("support") && !(await tx.conversation.findFirst({ where: sample(projectId), select: { id: true } })),
    };

    let people: string[] = [];
    if (missing.feedback || missing.support) {
      const emails = PEOPLE.map((_, n) => personEmail(projectId, n));
      await tx.user.createMany({ data: PEOPLE.map((name, n) => ({ id: randomUUID(), name, email: emails[n]! })), skipDuplicates: true });
      const rows = await tx.user.findMany({ where: { email: { in: emails } }, select: { id: true, email: true } });
      people = emails.map((email) => rows.find((row) => row.email === email)!.id);
    }

    const board = missing.feedback ? await tx.board.findFirst({ where: { projectId }, orderBy: { createdAt: "asc" }, select: { id: true } }) : null;
    for (const post of board ? POSTS : []) {
      const { postCount: number } = await tx.project.update({ where: { id: projectId }, data: { postCount: { increment: 1 } }, select: { postCount: true } });
      await tx.post.create({
        data: {
          ...sample(projectId),
          boardId: board!.id,
          authorId: people[post.voters[0]!]!,
          number,
          title: post.title,
          ...content(post.body),
          status: post.status,
          voteCount: post.voters.length,
          votes: { create: post.voters.map((n) => ({ userId: people[n]!, projectId })) },
          ...(post.comment && { commentCount: 1, comments: { create: { projectId, authorId: people[post.comment.by]!, ...content(post.comment.body) } } }),
          ...(post.status !== "OPEN" && { events: { create: { from: "OPEN", to: post.status } } }),
        },
      });
    }

    if (missing.docs) {
      const tabId = await tabFor(tx, projectId, { slug: undefined, parentId: null });
      const last = await tx.collection.aggregate({ where: { projectId, parentId: null, tabId }, _max: { order: true } });
      const collection = await tx.collection.create({
        data: {
          ...sample(projectId),
          tabId,
          slug: await freeDocsSlug(tx, projectId, DOCS.name, "collection"),
          name: DOCS.name,
          description: DOCS.description,
          icon: "rocket",
          order: (last._max.order ?? -1) + 1,
        },
        select: { id: true },
      });
      for (const [order, article] of DOCS.articles.entries()) {
        const { id } = await tx.article.create({
          data: {
            ...sample(projectId),
            collectionId: collection.id,
            slug: await freeDocsSlug(tx, projectId, article.title, "article"),
            title: article.title,
            ...content(article.body),
            publishedAt: now,
            order,
            createdById: userId,
          },
          select: { id: true },
        });
        await recordRevision(tx, id, userId);
      }
    }

    if (missing.changelog) {
      const { changelogCount: number } = await tx.project.update({ where: { id: projectId }, data: { changelogCount: { increment: 1 } }, select: { changelogCount: true } });
      await tx.changelogEntry.create({ data: { ...sample(projectId), number, title: UPDATE.title, ...content(UPDATE.body), tags: ["NEW"], publishedAt: now, createdById: userId } });
    }

    if (missing.support) {
      const { conversationCount: number } = await tx.project.update({
        where: { id: projectId },
        data: { conversationCount: { increment: 1 } },
        select: { conversationCount: true },
      });
      await tx.conversation.create({
        data: {
          ...sample(projectId),
          number,
          subject: CONVERSATION.subject,
          origin: "WIDGET",
          userId: people[0],
          lastMessageAt: now,
          waitingSince: now,
          messages: { create: { projectId, author: "USER", authorId: people[0], channel: "WIDGET", body: CONVERSATION.body } },
        },
      });
    }
  });
}

/**
 * Removes the project's sample content and its people, in one transaction: whatever the team changed in a
 * sample item, it goes with it (with its votes, comments and replies, the team's too). The team's own content
 * stays: a collection in the sample one moves up a level, articles in it are left in no collection, and posts
 * the sample people's votes or comments were merged into are counted again without them.
 */
export async function removeSampleContent(projectId: string) {
  await prisma.$transaction(async (tx) => {
    await lockProject(tx, projectId);
    const emails = PEOPLE.map((_, n) => personEmail(projectId, n));
    const people = (await tx.user.findMany({ where: { email: { in: emails } }, select: { id: true } })).map((person) => person.id);
    const touched = (
      await tx.post.findMany({
        where: { projectId, sample: false, OR: [{ votes: { some: { userId: { in: people } } } }, { comments: { some: { authorId: { in: people } } } }] },
        select: { id: true },
      })
    ).map((post) => post.id);
    for (const collection of await tx.collection.findMany({ where: sample(projectId), select: { id: true, parentId: true, tabId: true } })) {
      await tx.collection.updateMany({ where: { parentId: collection.id }, data: { parentId: collection.parentId, tabId: collection.tabId } });
    }
    await tx.conversation.deleteMany({ where: sample(projectId) });
    await tx.post.deleteMany({ where: sample(projectId) });
    await tx.article.deleteMany({ where: sample(projectId) });
    await tx.collection.deleteMany({ where: sample(projectId) });
    await tx.changelogEntry.deleteMany({ where: sample(projectId) });
    await tx.user.deleteMany({ where: { id: { in: people } } });
    if (touched.length > 0) {
      await tx.$executeRaw`
        UPDATE post SET
          "voteCount" = (SELECT count(*) FROM vote WHERE "postId" = post.id),
          "commentCount" = (SELECT count(*) FROM comment WHERE "postId" = post.id)
        WHERE id = ANY(${touched}::text[])`;
    }
  });
}

/** Whether the project has sample content (Home offers to remove it). */
export async function hasSampleContent(projectId: string) {
  const where = sample(projectId);
  const found = await Promise.all([
    prisma.post.findFirst({ where, select: { id: true } }),
    prisma.collection.findFirst({ where, select: { id: true } }),
    prisma.article.findFirst({ where, select: { id: true } }),
    prisma.changelogEntry.findFirst({ where, select: { id: true } }),
    prisma.conversation.findFirst({ where, select: { id: true } }),
  ]);
  return found.some(Boolean);
}
