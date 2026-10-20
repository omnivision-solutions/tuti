"use server";

import { prisma } from "@tuti/db";
import { embed, embeddingsEnabled, log, toVectorLiteral, TYPING_SUGGESTION_MIN_SIMILARITY } from "@tuti/shared";
import { z } from "zod";

import { readableProject } from "./portal-access";

export type SimilarPost = { id: string; number: number; title: string; voteCount: number; boardName: string };

const querySchema = z.string().trim().min(3).max(120);
const LIMIT = 5;
/** Shorter titles embed poorly (and cost a call per pause in typing). */
const MIN_EMBED_LENGTH = 10;

/**
 * Existing posts that look like the title being typed, across the project's
 * boards, so people vote instead of posting duplicates. Trigram similarity of
 * the whole title (or of the typed words within a longer title) catches
 * near-identical wording; with OPENAI_API_KEY set, embeddings also catch the
 * same idea in other words. Posts found both ways rank first.
 */
export async function findSimilarPosts(projectSlug: string, title: string): Promise<SimilarPost[]> {
  const query = querySchema.safeParse(title);
  if (!query.success) {
    return [];
  }
  const project = await readableProject(projectSlug);
  if (!project) {
    return [];
  }

  const [byWords, byMeaning] = await Promise.all([
    trigramMatches(project.id, query.data),
    query.data.length >= MIN_EMBED_LENGTH && embeddingsEnabled() ? embeddingMatches(project.id, query.data) : [],
  ]);
  const both = new Set(byWords.map((p) => p.id).filter((id) => byMeaning.some((p) => p.id === id)));
  const ranked = [
    ...byMeaning.filter((p) => both.has(p.id)),
    ...byMeaning.filter((p) => !both.has(p.id)),
    ...byWords.filter((p) => !both.has(p.id)),
  ];
  return ranked.slice(0, LIMIT);
}

function trigramMatches(projectId: string, query: string) {
  return prisma.$queryRaw<SimilarPost[]>`
    SELECT p.id, p.number, p.title, p."voteCount", b.name AS "boardName"
    FROM post p
    JOIN board b ON b.id = p."boardId"
    WHERE p."projectId" = ${projectId}
      AND p."duplicateOfId" IS NULL
      AND (p.title % ${query} OR ${query} <% p.title)
    ORDER BY greatest(similarity(p.title, ${query}), word_similarity(${query}, p.title)) DESC,
      p."voteCount" DESC
    LIMIT ${LIMIT}`;
}

async function embeddingMatches(projectId: string, query: string): Promise<SimilarPost[]> {
  let vector: string;
  try {
    const [embedding] = await embed([query]);
    vector = toVectorLiteral(embedding!);
  } catch (error) {
    log.warn("Embedding a typed title failed; using title matches only", { error });
    return [];
  }
  return prisma.$queryRaw<SimilarPost[]>`
    SELECT p.id, p.number, p.title, p."voteCount", b.name AS "boardName"
    FROM post_embedding e
    JOIN post p ON p.id = e."postId"
    JOIN board b ON b.id = p."boardId"
    WHERE e."projectId" = ${projectId}
      AND p."duplicateOfId" IS NULL
      AND 1 - (e.embedding <=> ${vector}::vector) >= ${TYPING_SUGGESTION_MIN_SIMILARITY}
    ORDER BY e.embedding <=> ${vector}::vector
    LIMIT ${LIMIT}`;
}
