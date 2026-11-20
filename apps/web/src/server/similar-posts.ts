"use server";

import { prisma } from "@tuti/db";
import { duplicatesMeter } from "@tuti/jobs";
import { duplicatesModel, duplicateText, embed, embeddingsEnabled, judgeDuplicates, log, toVectorLiteral, TYPING_SUGGESTION_MIN_SIMILARITY } from "@tuti/shared";
import { z } from "zod";

import { widgetUser } from "@/lib/widget-session";

import { canActIn } from "./membership";
import { currentPostViewer, readableProject } from "./portal-access";
import { type PostViewer, postViewer, visiblePostsSql } from "./post-visibility";
import { sessionIn } from "./session";

export type SimilarPost = { id: string; number: number; title: string; voteCount: number; boardName: string; boardSlug: string; voted: boolean };
type Candidate = Omit<SimilarPost, "voted"> & { body: string };

const querySchema = z.string().trim().min(3).max(120);
const LIMIT = 5;
/** Shorter titles embed poorly (and cost a call per pause in typing). */
const MIN_EMBED_LENGTH = 10;

/**
 * Existing posts that look like the title being typed, across the project's
 * boards, so people vote instead of posting duplicates. Trigram similarity of
 * the whole title (or of the typed words within a longer title) catches
 * near-identical wording; with OPENAI_API_KEY set, embeddings also catch the
 * same idea in other words. Posts found both ways rank first. Then the decision model (the config file's `duplicates.typing.model`) keeps
 * those it calls duplicates, likeliest first; without one, past the project's hourly checks, or when it fails or takes
 * over a second, the project is out of AI credits, or whoever's typing isn't signed in (it's charged to the project), they're
 * shown as found. With whether whoever's asking voted for
 * each: the widget's person, by its token (`widgetToken`), or the portal's signed-in user.
 */
export async function findSimilarPosts(projectSlug: string, title: string, widgetToken?: string | null): Promise<SimilarPost[]> {
  const query = querySchema.safeParse(title);
  if (!query.success) {
    return [];
  }
  const project = await readableProject(projectSlug);
  if (!project) {
    return [];
  }

  // Only posts they may see (post-visibility.ts): the widget's person, or whoever's reading the portal.
  const viewer = widgetToken ? await postViewer(project.id, widgetUser(project.id, String(widgetToken))) : await currentPostViewer(project.id);
  const [byWords, byMeaning] = await Promise.all([
    trigramMatches(project.id, query.data, viewer),
    query.data.length >= MIN_EMBED_LENGTH && embeddingsEnabled() ? embeddingMatches(project.id, query.data, viewer) : [],
  ]);
  const both = new Set(byWords.map((p) => p.id).filter((id) => byMeaning.some((p) => p.id === id)));
  const ranked = [
    ...byMeaning.filter((p) => both.has(p.id)),
    ...byMeaning.filter((p) => !both.has(p.id)),
    ...byWords.filter((p) => !both.has(p.id)),
  ];
  const userId = widgetToken ? widgetUser(project.id, String(widgetToken)) : (await sessionIn(project.id))?.user.id;
  // Every candidate is judged (up to twice LIMIT, one request), so a duplicate found only by its words isn't cut first.
  // Only for someone who can post here: the check is charged to the project, and anyone can type on a portal.
  const judged = userId && (await canActIn(userId, project.id)) ? await duplicatesOnly(project.id, query.data, ranked) : ranked;
  const shown = judged.slice(0, LIMIT);
  const votes = userId && shown.length > 0 ? await prisma.vote.findMany({ where: { userId, postId: { in: shown.map((post) => post.id) } }, select: { postId: true } }) : [];
  return shown.map(({ body: _, ...post }) => ({ ...post, voted: votes.some((vote) => vote.postId === post.id) }));
}

/** Checks by the decision model per project an hour, at most: the search is public, so anyone could run it up. */
const CHECKS_PER_PROJECT_PER_HOUR = 300;
// ponytail: counted per server process, so each web container allows this many; a table if one ever needs a shared count.
const checks = new Map<string, { hour: number; count: number }>();

async function duplicatesOnly(projectId: string, title: string, found: Candidate[]): Promise<Candidate[]> {
  const model = duplicatesModel("typing");
  if (!model || found.length === 0) {
    return found;
  }
  const hour = Math.floor(Date.now() / 3_600_000);
  const used = checks.get(projectId);
  const count = used?.hour === hour ? used.count : 0;
  if (count >= CHECKS_PER_PROJECT_PER_HOUR) {
    return found;
  }
  // The slot is taken before anything is awaited, so searches at once can't all read the same count.
  checks.set(projectId, { hour, count: count + 1 });
  // Charged in AI credits like any AI feature: out of them, or when the balance can't be read, the posts are shown as
  // found (and the slot given back).
  const meter = await duplicatesMeter(projectId).catch((error: unknown) => {
    log.warn("Reading AI credits for a duplicates check failed; showing similar posts as found", { error });
    return null;
  });
  if (!meter) {
    const now = checks.get(projectId);
    if (now?.hour === hour) {
      checks.set(projectId, { hour, count: now.count - 1 });
    }
    return found;
  }
  try {
    const verdicts = await judgeDuplicates(model, title, found.map(duplicateText), 1_000, meter);
    return found
      .map((post, k) => ({ post, verdict: verdicts[k]! }))
      .filter(({ verdict }) => verdict.verdict === "duplicate")
      .sort((a, b) => b.verdict.duplicate - a.verdict.duplicate)
      .map(({ post }) => post);
  } catch (error) {
    log.warn("Judging similar posts while typing failed; showing them as found", { error });
    return found;
  }
}

function trigramMatches(projectId: string, query: string, viewer: PostViewer) {
  return prisma.$queryRaw<Candidate[]>`
    SELECT p.id, p.number, p.title, p.body, p."voteCount", b.name AS "boardName", b.slug AS "boardSlug"
    FROM post p
    JOIN board b ON b.id = p."boardId"
    WHERE p."projectId" = ${projectId}
      AND p."duplicateOfId" IS NULL AND ${visiblePostsSql(viewer)}
      AND (p.title % ${query} OR ${query} <% p.title)
    ORDER BY greatest(similarity(p.title, ${query}), word_similarity(${query}, p.title)) DESC,
      p."voteCount" DESC
    LIMIT ${LIMIT}`;
}

async function embeddingMatches(projectId: string, query: string, viewer: PostViewer): Promise<Candidate[]> {
  let vector: string;
  try {
    const [embedding] = await embed([query]);
    vector = toVectorLiteral(embedding!);
  } catch (error) {
    log.warn("Embedding a typed title failed; using title matches only", { error });
    return [];
  }
  return prisma.$queryRaw<Candidate[]>`
    SELECT p.id, p.number, p.title, p.body, p."voteCount", b.name AS "boardName", b.slug AS "boardSlug"
    FROM post_embedding e
    JOIN post p ON p.id = e."postId"
    JOIN board b ON b.id = p."boardId"
    WHERE e."projectId" = ${projectId}
      AND p."duplicateOfId" IS NULL AND ${visiblePostsSql(viewer)}
      AND 1 - (e.embedding <=> ${vector}::vector) >= ${TYPING_SUGGESTION_MIN_SIMILARITY}
    ORDER BY e.embedding <=> ${vector}::vector
    LIMIT ${LIMIT}`;
}
