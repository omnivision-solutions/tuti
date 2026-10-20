import { createHash } from "node:crypto";

/**
 * OpenAI text embeddings for duplicate detection. Optional: without
 * OPENAI_API_KEY, posting works and duplicate detection is skipped.
 */
export const EMBEDDING_MODEL = "text-embedding-3-small";

/**
 * Cosine similarity cut-offs, calibrated on text-embedding-3-small: duplicates
 * scored ~0.47–0.65, related-but-different posts ~0.32–0.59, unrelated ~0.1–0.2.
 * Embeddings separate related from unrelated, not duplicate from related, so
 * these only produce suggestions a person confirms.
 */
export const DUPLICATE_MIN_SIMILARITY = 0.45;
export const TYPING_SUGGESTION_MIN_SIMILARITY = 0.4;
/** A pull request's text vs. a post's. ponytail: not calibrated yet (PRs say "how", posts "what"); tune with real pairs. */
export const LINK_MIN_SIMILARITY = 0.4;
/** A search query vs. a help article's section. ponytail: not calibrated yet; tune with real queries (and the misses log). */
export const SEARCH_MIN_SIMILARITY = 0.3;
/**
 * A question vs. a help article's section, for AI answers: below it the section isn't sent to the
 * model, and with no section left the answer is "I don't know". Stricter than search, which only
 * lists articles. ponytail: not calibrated yet; tune with real questions (the help_question log).
 */
export const ANSWER_MIN_SIMILARITY = 0.4;

export function embeddingsEnabled(): boolean {
  return Boolean(process.env.OPENAI_API_KEY);
}

/** What gets embedded for a post. */
export function postEmbeddingText(post: { title: string; body: string }): string {
  return `${post.title}\n\n${post.body}`.trim().slice(0, 8000);
}

/** What gets embedded for a section of a help article: the article's title gives it context. */
export function articleChunkText(title: string, chunk: { heading: string; text: string }): string {
  return [title, chunk.heading, chunk.text].filter(Boolean).join("\n\n");
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
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error("OPENAI_API_KEY is not set");
  }
  const baseUrl = process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1";
  const response = await fetch(`${baseUrl}/embeddings`, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: EMBEDDING_MODEL, input: texts }),
    signal,
  });
  const json = (await response.json()) as {
    data?: { index: number; embedding: number[] }[];
    error?: { message?: string };
  };
  if (!response.ok || !json.data) {
    throw new Error(`OpenAI embeddings failed (${response.status}): ${json.error?.message ?? "no data"}`);
  }
  return json.data.sort((a, b) => a.index - b.index).map((d) => d.embedding);
}
