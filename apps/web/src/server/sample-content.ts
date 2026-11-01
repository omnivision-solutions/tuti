import { randomUUID } from "node:crypto";

import { fromPlainText } from "@tuti/content";
import { type Prisma, prisma } from "@tuti/db";
import { lockProject } from "@tuti/jobs";

import { PROJECT_USE_KEYS } from "@/lib/project-uses";

import { withLockRetries } from "./lock-retries";
import { freeDocsSlug, recordRevision, tabFor } from "./operations/docs";

/**
 * Sample content to try things with (docs/plan.md, the redesign's step 6), for what the team picked after
 * "Create project" (all four without picks): posts on the first board with votes, a comment and a status
 * (Feedback), a collection of two articles (Docs), an update (Changelog) and a conversation (Support). Each
 * is marked `sample`: labelled Sample, left out of Home, and removed with removeSampleContent.
 *
 * Written straight to the database, so nothing is emailed, queued (no embeddings, duplicates, Autopilot or
 * webhooks) or counted. Its people are accounts of their own (`sampleProjectId`), at random placeholder
 * addresses (`.invalid`, unverified, like a project's SSO users'), which Tuti never emails. Later, sample posts
 * send no webhooks or emails (packages/jobs events.ts, operations/create.ts), and its articles are never embedded.
 */

const PEOPLE = ["Alex Rivera", "Sam Okafor", "Jordan Lee"];

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

/**
 * The project's row, for removing sample content or merging a sample post: FOR NO KEY UPDATE, so it waits for (and
 * holds off) adding sample content (lockProject's FOR UPDATE) and other removals and sample merges, but not a vote or
 * comment being saved (their foreign key takes the row FOR KEY SHARE after locking the post, which FOR UPDATE would
 * block: a deadlock with the post locks taken here).
 */
export async function lockSampleContent(tx: Prisma.TransactionClient, projectId: string) {
  await tx.$queryRaw`SELECT id FROM project WHERE id = ${projectId} FOR NO KEY UPDATE`;
}

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

    // The project's sample people, made once (by name, in PEOPLE's order).
    let people: string[] = [];
    if (missing.feedback || missing.support) {
      const rows = await tx.user.findMany({ where: { sampleProjectId: projectId }, select: { id: true, name: true } });
      people = PEOPLE.map((name) => rows.find((row) => row.name === name)?.id ?? randomUUID());
      await tx.user.createMany({
        data: PEOPLE.flatMap((name, n) =>
          rows.some((row) => row.id === people[n]) ? [] : [{ id: people[n]!, name, email: `sample-${randomUUID()}@users.tuti.invalid`, sampleProjectId: projectId }],
        ),
      });
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
          slug: await freeDocsSlug(tx, projectId, DOCS.name, "collection", undefined, { keepRedirects: true }),
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
            slug: await freeDocsSlug(tx, projectId, article.title, "article", undefined, { keepRedirects: true }),
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
    // Past Prisma's 5 seconds: it may wait on the project's lock (a publish, a removal, a sample post's merge).
  }, { timeout: 30_000 });
}

/**
 * Removes the project's sample content and its people, in one transaction: whatever the team changed in a
 * sample item, it goes with it (with its votes, comments and replies, the team's too). The team's own content
 * stays: a sample collection the team put articles or collections in (or has an unpublished move into) becomes theirs (with its place and who
 * may read it), and posts the sample people's votes or comments were merged into are counted again without
 * them. (A real post can't be merged into a sample one: manage.ts refuses.)
 */
export async function removeSampleContent(projectId: string) {
  // Its locks (the touched posts, found pass by pass) can't all be taken in one order, so a merge can deadlock with it:
  // Postgres then aborts one, and an aborted removal starts again (withLockRetries).
  await withLockRetries(() => removeOnce(projectId));
}

async function removeOnce(projectId: string) {
  await prisma.$transaction(async (tx) => {
    await lockSampleContent(tx, projectId);
    // The sample posts locked too: a merge of one into a real post (which locks both) finishes first, so the post it
    // went into is counted again below, or waits and then finds it gone.
    await tx.$queryRaw`SELECT id FROM post WHERE "projectId" = ${projectId} AND sample FOR UPDATE`;
    const people = (await tx.user.findMany({ where: { sampleProjectId: projectId }, select: { id: true } })).map((person) => person.id);
    // The real posts the sample people's votes and comments are on, locked (in id order) before they're counted again
    // below. A merge moving those rows (it locks both posts) finishes first, and the post it moved them to is found and
    // locked on the next pass; once locked, they stay put. A vote or comment arriving meanwhile waits, then counts on top.
    const touched: string[] = [];
    for (;;) {
      const found = (
        await tx.post.findMany({
          where: {
            projectId,
            sample: false,
            id: { notIn: touched },
            OR: [{ votes: { some: { userId: { in: people } } } }, { comments: { some: { authorId: { in: people } } } }],
          },
          orderBy: { id: "asc" },
          select: { id: true },
        })
      ).map((post) => post.id);
      if (found.length === 0) {
        break;
      }
      await tx.$queryRaw`SELECT id FROM post WHERE id = ANY(${found}::text[]) ORDER BY id FOR NO KEY UPDATE`;
      touched.push(...found);
    }
    // Locked before they're checked: an article or collection saved into one meanwhile (its foreign key on the
    // collection) waits for this, so nothing the team adds slips in between the check and the delete.
    await tx.$queryRaw`SELECT id FROM collection WHERE "projectId" = ${projectId} AND sample ORDER BY id FOR UPDATE`;
    await tx.collection.updateMany({
      // Its articles, unpublished moves into it (article_changes) and collections in it.
      where: {
        ...sample(projectId),
        OR: [{ articles: { some: { sample: false } } }, { changes: { some: { article: { sample: false } } } }, { children: { some: { sample: false } } }],
      },
      data: { sample: false },
    });
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
    // Past Prisma's 5 seconds, as mergePosts: it may wait on the project's lock and on merges holding the posts it counts again.
  }, { timeout: 30_000 });
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
