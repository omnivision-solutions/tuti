import { createHash } from "node:crypto";

import { embeddingsEndpoint, throughOpenRouter } from "./provider";

/**
 * OpenAI's text embeddings, for duplicate detection and docs search, through the AI provider (./provider).
 * Optional: without OPENAI_API_KEY, posting works and duplicate detection is skipped.
 *
 * The model's name as stored with vectors and hashed in contentHash. OpenRouter serves the same model,
 * with the same vectors, as openai/text-embedding-3-small: only the id sent there differs, so nothing is
 * embedded again.
 */
export const EMBEDDING_MODEL = "text-embedding-3-small";

/** The model id the endpoint knows it by. */
export function embeddingModelId(endpoint = embeddingsEndpoint()): string {
  return throughOpenRouter(endpoint) ? `openai/${EMBEDDING_MODEL}` : EMBEDDING_MODEL;
}

/**
 * Cosine similarity cut-offs, calibrated on text-embedding-3-small: duplicates
 * scored ~0.47–0.65, related-but-different posts ~0.32–0.59, unrelated ~0.1–0.2.
 * Embeddings separate related from unrelated, not duplicate from related, so
 * these only produce suggestions a person confirms.
 */
export const DUPLICATE_MIN_SIMILARITY = 0.45;
export const TYPING_SUGGESTION_MIN_SIMILARITY = 0.4;
/** A search query vs. a docs article's section. ponytail: not calibrated yet; tune with real queries (and the misses log). */
export const SEARCH_MIN_SIMILARITY = 0.3;
/**
 * A question vs. a docs article's section, for AI answers: below it the section isn't sent to the
 * model, and with no section left the answer is "I don't know". Stricter than search, which only
 * lists articles. ponytail: not calibrated yet; tune with real questions (the docs_question log).
 */
export const ANSWER_MIN_SIMILARITY = 0.4;

export function embeddingsEnabled(): boolean {
  return Boolean(process.env.OPENAI_API_KEY);
}

/** What gets embedded for a post. */
export function postEmbeddingText(post: { title: string; body: string }): string {
  return `${post.title}\n\n${post.body}`.trim().slice(0, 8000);
}

/** What gets embedded for a section of a docs article: the article's title gives it context. */
export function articleChunkText(title: string, chunk: { heading: string; text: string }, keywords: string[] = []): string {
  return [title, chunk.heading, chunk.text, keywords.length > 0 ? `Keywords: ${keywords.join(", ")}` : ""].filter(Boolean).join("\n\n");
}

export function contentHash(text: string): string {
  return createHash("sha256").update(`${EMBEDDING_MODEL}\n${text}`).digest("hex");
}

/** pgvector literal, e.g. "[0.1,0.2]", to cast with ::vector in SQL. */
export function toVectorLiteral(vector: number[]): string {
  return `[${vector.join(",")}]`;
}

/** `signal` cancels the request, e.g. `AbortSignal.timeout(…)` where someone is waiting for it. */
export async function embed(texts: string[], signal?: AbortSignal): Promise<number[][]> {
  const endpoint = embeddingsEndpoint();
  if (!endpoint.apiKey) {
    throw new Error("OPENAI_API_KEY is not set");
  }
  const response = await fetch(`${endpoint.baseUrl}/embeddings`, {
    method: "POST",
    headers: { Authorization: `Bearer ${endpoint.apiKey}`, "Content-Type": "application/json" },
    // Through OpenRouter, only providers that neither train on the text nor keep it, as for every other request (OpenAI's API refuses the field).
    body: JSON.stringify({ model: embeddingModelId(endpoint), input: texts, ...(throughOpenRouter(endpoint) && { provider: { data_collection: "deny" } }) }),
    signal,
  });
  // Not JSON (a proxy's error page, say): the status still says what went wrong.
  const json = (await response.json().catch(() => null)) as {
    data?: { index: number; embedding: number[] }[];
    error?: { message?: string };
  } | null;
  if (!response.ok || !json?.data) {
    throw new Error(`Embeddings failed (${response.status}): ${json?.error?.message ?? "no data"}`);
  }
  return json.data.sort((a, b) => a.index - b.index).map((d) => d.embedding);
}
