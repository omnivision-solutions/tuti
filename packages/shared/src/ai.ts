import { embeddingsEnabled } from "./embeddings";
import { answeredBy, dollars, type Meter, tokens } from "./usage";

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

/** What an AI request is for: each feature has its own default model, and a project can pick another. */
export const AI_FEATURES = ["answers", "escalations", "changelog", "code_changes"] as const;
export type AiFeature = (typeof AI_FEATURES)[number];

/** A feature's model for every project: AI_MODEL_<FEATURE> (e.g. AI_MODEL_ANSWERS, a model id), else AI_MODEL, else Tuti's default. */
export function defaultModel(feature: AiFeature): string {
  return process.env[`AI_MODEL_${feature.toUpperCase()}`] || process.env.AI_MODEL || DEFAULT_AI_MODEL;
}

/** What a piece of a feature's work asks the AI with: the model, and the meter recording each request for its project. */
export type Ai = { model: string; meter: Meter };

/** The model's reply to one system and one user message. Throws on any failure, with the reason. */
export async function complete({
  system,
  user,
  maxTokens = 4000,
  timeoutMs = 60_000,
  model,
  meter,
}: {
  system: string;
  user: string;
  maxTokens?: number;
  timeoutMs?: number;
} & Ai): Promise<string> {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    throw new Error("OPENROUTER_API_KEY is not set");
  }
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
    model?: unknown;
    choices?: { message?: { content?: unknown } }[];
    usage?: { prompt_tokens?: unknown; completion_tokens?: unknown; cost?: unknown };
    error?: { message?: string };
  } | null;
  if (!response.ok) {
    throw new Error(`AI request failed (${response.status}): ${json?.error?.message ?? "no details"}`);
  }
  // Answered, so paid for, whatever the reply says.
  await meter({
    kind: "chat",
    model: answeredBy(json?.model, model),
    inputTokens: tokens(json?.usage?.prompt_tokens),
    outputTokens: tokens(json?.usage?.completion_tokens),
    cost: dollars(json?.usage?.cost),
  });
  const content = json?.choices?.[0]?.message?.content;
  if (typeof content !== "string" || content.trim() === "") {
    throw new Error("The AI reply had no text");
  }
  return content;
}

/** A model the endpoint serves (OpenRouter's GET /models), with its price in dollars per token when it says. */
export type AiModelListing = { id: string; name: string; input: number | null; output: number | null };

/** The endpoint's models. Throws on any failure. */
export async function listModels(): Promise<AiModelListing[]> {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    throw new Error("OPENROUTER_API_KEY is not set");
  }
  const response = await fetch(`${baseUrl()}/models`, { headers: { Authorization: `Bearer ${apiKey}` }, signal: AbortSignal.timeout(10_000) });
  const json = (await response.json().catch(() => null)) as { data?: { id?: unknown; name?: unknown; pricing?: { prompt?: unknown; completion?: unknown } }[] } | null;
  if (!response.ok || !Array.isArray(json?.data)) {
    throw new Error(`Listing the AI models failed (${response.status})`);
  }
  // OpenRouter's prices are strings of dollars per token.
  const price = (value: unknown) => dollars(typeof value === "string" ? Number(value) : value);
  return json.data
    .filter((model): model is { id: string; name?: unknown; pricing?: { prompt?: unknown; completion?: unknown } } => typeof model.id === "string" && model.id !== "")
    .map((model) => ({
      id: model.id,
      name: typeof model.name === "string" ? model.name : model.id,
      input: price(model.pricing?.prompt),
      output: price(model.pricing?.completion),
    }));
}

/** The operator's cap on the models projects may pick (AI_MODEL_MAX_PRICE, dollars per million output tokens), or null for none. */
export function modelMaxPrice(): number | null {
  const value = Number(process.env.AI_MODEL_MAX_PRICE);
  return process.env.AI_MODEL_MAX_PRICE && Number.isFinite(value) && value > 0 ? value : null;
}

/** Whether a project may pick `model` under modelMaxPrice: any model without a cap; with one, only a model with a price at or under it. */
export function withinModelCap(model: AiModelListing): boolean {
  const cap = modelMaxPrice();
  // Compared in millionths of a dollar per million tokens, so a price written like the cap isn't over it by a rounding error.
  return cap === null || (model.output !== null && Math.round(model.output * 1e12) <= Math.round(cap * 1e6));
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
    model?: unknown;
    answers?: Record<string, unknown>;
    usage?: { input_tokens?: unknown; output_tokens?: unknown; cost?: unknown };
    error?: { message?: string };
  } | null;
  if (!response.ok) {
    throw new Error(`Decision request failed (${response.status}): ${json?.error?.message ?? "no details"}`);
  }
  await meter({
    kind: "decision",
    model: answeredBy(json?.model, decisionModel()),
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
