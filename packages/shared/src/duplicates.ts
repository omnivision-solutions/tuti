import { decide, type DecisionQuestion } from "./ai";
import { config } from "./config";
import { decisionsAvailable } from "./provider";

export { DEFAULT_DUPLICATES_MODEL } from "./config/duplicates";

/** Below this embedding similarity a post isn't asked about at all; the decision model judges the rest. */
export const DUPLICATE_CANDIDATE_MIN_SIMILARITY = 0.35;

/**
 * The decision model that judges duplicate candidates (the config file's `duplicates.posted.model` after a post is
 * created, `duplicates.typing.model` while a title is typed), or null for embeddings alone: `off`, or a provider without
 * OpenRouter's Decisions API.
 */
export function duplicatesModel(when: "posted" | "typing"): string | null {
  const { model } = config().duplicates[when];
  return model === "off" || !decisionsAvailable() ? null : model;
}

export type DuplicateVerdict = { verdict: "duplicate" | "related" | "different"; duplicate: number };

const CRITERIA = {
  duplicate: "Both posts ask for the same thing: building one would fully satisfy the other, so their votes belong together.",
  related: "Same area, or one builds on the other, but each asks for something the other doesn't deliver.",
  different: "They ask for different things, even if they share words or a topic.",
};

/**
 * The decision model's verdict on each candidate (in order) for `post`: each a post's title, and its body when there is
 * one. One request, a question per candidate. Not recorded or charged: like embeddings, a request costs less than the
 * row recording it (docs/plan.md). Throws on any failure, so the caller can fall back to embeddings alone.
 */
export async function judgeDuplicates(model: string, post: string, candidates: string[], timeoutMs: number): Promise<DuplicateVerdict[]> {
  const state = { new: post, ...Object.fromEntries(candidates.map((text, k) => [`existing_${k}`, text])) };
  const questions = Object.fromEntries(
    candidates.map((_, k): [string, DecisionQuestion] => [
      `duplicate_${k}`,
      { type: "choice", instructions: `A feedback board. Someone is posting \`new\`. Is it a duplicate of \`existing_${k}\`?`, criteria: CRITERIA },
    ]),
  );
  const answers = await decide(state, questions, { model, timeoutMs, meter: async () => {} });
  return candidates.map((_, k) => {
    const answer = answers[`duplicate_${k}`]!;
    if (answer.type !== "choice" || !Object.hasOwn(CRITERIA, answer.choice)) {
      throw new Error(`The decision model answered duplicate_${k} with ${JSON.stringify(answer)}`);
    }
    return { verdict: answer.choice as DuplicateVerdict["verdict"], duplicate: answer.probabilities.duplicate ?? 0 };
  });
}

/** A post as the decision model reads it: its title, then its body (cut short). */
export function duplicateText(post: { title: string; body?: string }): string {
  return `${post.title}\n\n${post.body ?? ""}`.trim().slice(0, 2000);
}
