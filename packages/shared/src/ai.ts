import { embeddingsEnabled } from "./embeddings";
import { dollars, type Meter, tokens } from "./usage";

/**
 * Text generation through an OpenAI-compatible chat completions API: OpenRouter
 * by default, or any compatible endpoint (OPENROUTER_BASE_URL). Optional: without
 * OPENROUTER_API_KEY, AI features are off.
 */
export const DEFAULT_AI_MODEL = "anthropic/claude-haiku-5.5";
const DEFAULT_BASE_URL = "https://openrouter.ai/api/v1";

/** Every request asks for providers that neither train on prompts nor keep them (OpenRouter's data policy; other endpoints ignore it). */
const PROVIDER = { data_collection: "deny" } as const;

const baseUrl = () => (process.env.OPENROUTER_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, "");

export function aiEnabled(): boolean {
  return Boolean(process.env.OPENROUTER_API_KEY);
}

/** Where AI requests go (the endpoint's host, e.g. openrouter.ai), to tell teams what's sent where. */
export function aiProvider(): string {
  return new URL(baseUrl()).hostname;
}

/**
 * Code changes (merged pull requests analysed into proposed actions) need the AI (its decision model
 * too) and embeddings (to find the posts and articles a change may touch). Without either, merged pull
 * requests only feed the changelog's running draft.
 */
export function codeChangesEnabled(): boolean {
  return aiEnabled() && embeddingsEnabled();
}

/** The model's reply to one system and one user message. Throws on any failure, with the reason. */
export async function complete({
  system,
  user,
  maxTokens = 4000,
  timeoutMs = 60_000,
  meter,
}: {
  system: string;
  user: string;
  maxTokens?: number;
  timeoutMs?: number;
  /** Records what the request used, for the project that caused it. */
  meter: Meter;
}): Promise<string> {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    throw new Error("OPENROUTER_API_KEY is not set");
  }
  const model = process.env.AI_MODEL || DEFAULT_AI_MODEL;
  const response = await fetch(`${baseUrl()}/chat/completions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      max_tokens: maxTokens,
      provider: PROVIDER,
      // OpenRouter says what the request cost (other endpoints ignore it).
      usage: { include: true },
    }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const json = (await response.json().catch(() => null)) as {
    choices?: { message?: { content?: unknown } }[];
    usage?: { prompt_tokens?: unknown; completion_tokens?: unknown; cost?: unknown };
    error?: { message?: string };
  } | null;
  if (!response.ok) {
    throw new Error(`AI request failed (${response.status}): ${json?.error?.message ?? "no details"}`);
  }
  // Answered, so paid for, whatever the reply says.
  await meter({ kind: "chat", model, inputTokens: tokens(json?.usage?.prompt_tokens), outputTokens: tokens(json?.usage?.completion_tokens), cost: dollars(json?.usage?.cost) });
  const content = json?.choices?.[0]?.message?.content;
  if (typeof content !== "string" || content.trim() === "") {
    throw new Error("The AI reply had no text");
  }
  return content;
}

/**
 * The decision model, apart from the writing model: DECISION_MODEL, by default the one that did best
 * on code changes' evaluation set (`pnpm test:live`; 2026-10-23, among OpenRouter's decision models).
 */
export const DEFAULT_DECISION_MODEL = "nace-ai/drex-max";

export function decisionModel(): string {
  return process.env.DECISION_MODEL || DEFAULT_DECISION_MODEL;
}

/** A bounded question for the decision model: yes or no ("noul"), or one of a few named options. */
export type DecisionQuestion =
  | { type: "noul"; instructions: string; criteria: { true: string; false: string } }
  | { type: "choice"; instructions: string; criteria: Record<string, string> };

/** Its answer: the probability of yes, or each option's probability (and the likeliest). */
export type DecisionAnswer = { type: "noul"; noul: number } | { type: "choice"; choice: string; probabilities: Record<string, number> };

/**
 * Asks the decision model (decisionModel) about `state` through OpenRouter's Decisions API (beside
 * the chat API: /api/alpha/decisions for /api/v1). Decision models only answer, with calibrated
 * probabilities: no text. Throws on any failure (an endpoint that can't serve the model too), or if a
 * question comes back unanswered.
 */
export async function decide(
  state: unknown,
  questions: Record<string, DecisionQuestion>,
  { timeoutMs = 30_000, meter }: { timeoutMs?: number; meter: Meter },
): Promise<Record<string, DecisionAnswer>> {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    throw new Error("OPENROUTER_API_KEY is not set");
  }
  const response = await fetch(new URL("../alpha/decisions", `${baseUrl()}/`), {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: decisionModel(), state, questions, provider: PROVIDER }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const json = (await response.json().catch(() => null)) as {
    answers?: Record<string, unknown>;
    usage?: { input_tokens?: unknown; output_tokens?: unknown; cost?: unknown };
    error?: { message?: string };
  } | null;
  if (!response.ok) {
    throw new Error(`Decision request failed (${response.status}): ${json?.error?.message ?? "no details"}`);
  }
  await meter({
    kind: "decision",
    model: decisionModel(),
    inputTokens: tokens(json?.usage?.input_tokens),
    outputTokens: tokens(json?.usage?.output_tokens),
    cost: dollars(json?.usage?.cost),
  });
  const answers: Record<string, DecisionAnswer> = {};
  const probability = (value: unknown) => typeof value === "number" && value >= 0 && value <= 1;
  for (const [name, question] of Object.entries(questions)) {
    const answer = json?.answers?.[name] as { type?: unknown; noul?: unknown; choice?: unknown; probabilities?: Record<string, unknown> } | undefined;
    const probabilities = answer?.probabilities;
    if (question.type === "noul" && answer?.type === "noul" && probability(answer.noul)) {
      answers[name] = { type: "noul", noul: answer.noul as number };
    } else if (
      question.type === "choice" &&
      answer?.type === "choice" &&
      typeof answer.choice === "string" &&
      probabilities &&
      Object.keys(question.criteria).every((option) => probability(probabilities[option]))
    ) {
      answers[name] = { type: "choice", choice: answer.choice, probabilities: probabilities as Record<string, number> };
    } else {
      throw new Error(`The decision model didn't answer ${name}`);
    }
  }
  return answers;
}
