import { CODE_CHANGES_SETTINGS, codeChangesSettings } from "./code-changes-settings";
import { embed, EMBEDDING_MODEL, embeddingModelId, embeddingsEnabled } from "./embeddings";
import { log } from "./log";
import { aiSetup, chatEndpoint, decisionsAvailable, embeddingsEndpoint, isOpenRouter, throughOpenRouter, webAddress } from "./provider";
import { answeredBy, dollars, type Meter, replyCost, tokens } from "./usage";

/**
 * Text generation through an OpenAI-compatible chat completions API: OpenRouter by default, or any
 * compatible endpoint (where: ./provider). Optional: without a key, AI features are off.
 */
export const DEFAULT_AI_MODEL = "anthropic/claude-haiku-5.5";

/** Every request asks for providers that neither train on prompts nor keep them (OpenRouter's data policy; other endpoints ignore it). */
const PROVIDER = { data_collection: "deny" } as const;

const baseUrl = () => chatEndpoint().baseUrl;

export function aiEnabled(): boolean {
  return Boolean(chatEndpoint().apiKey);
}

/** The chat endpoint's key; throws if chat is off. */
function chatKey(): string {
  const { apiKey } = chatEndpoint();
  if (!apiKey) {
    throw new Error("OPENAI_API_KEY is not set");
  }
  return apiKey;
}

/** Where AI requests go (the endpoint's host, e.g. openrouter.ai), to tell teams what's sent where. */
export function aiProvider(): string {
  // An address that isn't a URL isn't shown (it could hold credentials); the start-up check says what's wrong with it.
  return webAddress(baseUrl())?.hostname ?? "an address that isn't a URL";
}

/**
 * Code changes (merged pull requests analysed into proposed actions, Autopilot) and Verify need the AI,
 * its decision model through OpenRouter's Decisions API (decisionsAvailable: elsewhere every decision
 * would fail), and embeddings (to find the posts and articles a change may touch). Without them, merged
 * pull requests only feed the changelog's running draft.
 */
export function codeChangesEnabled(): boolean {
  return aiEnabled() && embeddingsEnabled() && decisionsAvailable();
}

/** Whether AI works here but Autopilot and Verify can't: the provider has no Decisions API (to say so, not that AI is off). */
export function decisionsMissing(): boolean {
  return aiEnabled() && !decisionsAvailable();
}

/** What Autopilot and Verify still need on this server, in words: OpenRouter, for the Decisions API. */
export function codeChangesFix(): string {
  return "an OpenRouter key in OPENAI_API_KEY, with OPENAI_BASE_URL unset (see .env.example)";
}

/** Why Autopilot and Verify are off on this server, as a phrase ("… while <it>"), or null when they're on. */
export function codeChangesOff(): string | null {
  if (codeChangesEnabled()) {
    return null;
  }
  if (!aiEnabled()) {
    return "AI isn't set up on this server";
  }
  return "this server's AI provider doesn't have OpenRouter's Decisions API";
}

/** What an AI request is for: each feature has its own default model, and a project can pick another. */
export const AI_FEATURES = ["answers", "escalations", "changelog", "code_changes", "support"] as const;
export type AiFeature = (typeof AI_FEATURES)[number];

/**
 * A feature's model for every project: AI_MODEL_<FEATURE> (e.g. AI_MODEL_ANSWERS, a model id), else AI_MODEL, else
 * Tuti's default (for code changes, Autopilot's write model: CODE_CHANGES_WRITE_MODEL).
 */
export function defaultModel(feature: AiFeature): string {
  return (
    process.env[`AI_MODEL_${feature.toUpperCase()}`] || process.env.AI_MODEL || (feature === "code_changes" ? codeChangesSettings().write.model : DEFAULT_AI_MODEL)
  );
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
  const apiKey = chatKey();
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
      // OpenRouter's own fields (data policy, what the request cost) only through it: other providers refuse unknown ones.
      ...(throughOpenRouter(chatEndpoint()) && { provider: PROVIDER, usage: { include: true } }),
    }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const json = (await response.json().catch(() => null)) as {
    model?: unknown;
    choices?: { message?: { content?: unknown } }[];
    usage?: { prompt_tokens?: unknown; completion_tokens?: unknown } & Parameters<typeof replyCost>[0];
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
    cost: replyCost(json?.usage),
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
  const apiKey = chatKey();
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

/**
 * At start-up (web and worker): says what the setup keeps from before, then asks the endpoint for its
 * models and logs one error if that fails, saying whether the key or the address looks wrong, or if it
 * doesn't list a chat model the server uses (AI_MODEL, a feature's, or Tuti's default). Never throws:
 * AI is optional.
 */
/** An address as logs may show it: its origin only (a user, password, path or query could hold a credential). */
export function shownAddress(address: string): string {
  return webAddress(address)?.origin ?? "an address that isn't a URL";
}

/** One endpoint's key and address, checked by listing its models: the answer when both look right, else null (and one error logged). */
async function checkEndpoint(endpoint: ReturnType<typeof chatEndpoint>): Promise<Response | null> {
  const get = (path: string) =>
    fetch(`${endpoint.baseUrl}/${path}`, { headers: { Authorization: `Bearer ${endpoint.apiKey}` }, signal: AbortSignal.timeout(10_000) }).catch(() => null);
  const models = await get("models");
  const status = models?.status ?? 0;
  // OpenRouter lists its models to anyone; its /key answers only to a good key.
  const keyStatus = status === 200 && isOpenRouter(endpoint) ? ((await get("key"))?.status ?? 0) : status;
  if (keyStatus === 401 || keyStatus === 403) {
    log.error(`The AI provider at ${shownAddress(endpoint.baseUrl)} turned down OPENAI_API_KEY (${keyStatus}): the key looks wrong. AI features will fail until it's fixed.`);
    return null;
  }
  if (!models || status !== 200) {
    log.error(`Couldn't list the AI models at ${shownAddress(endpoint.baseUrl)} (${status || "no answer"}): the address (OPENAI_BASE_URL) looks wrong. AI features will fail until it's fixed.`);
    return null;
  }
  return models;
}

/**
 * An embeddings-only endpoint, checked with what Tuti calls there: one word embedded (a fraction of a cent). Listing its
 * models would turn away a key limited to what Tuti uses (OpenAI's restricted keys can embed without listing models).
 */
async function checkEmbeddings(endpoint: ReturnType<typeof embeddingsEndpoint>): Promise<void> {
  const failure = await embed(["ok"], AbortSignal.timeout(10_000)).then(
    () => null,
    (error: unknown) => (error instanceof Error ? error.message : String(error)),
  );
  if (!failure) {
    return;
  }
  const status = Number(/\((\d{3})\)/.exec(failure)?.[1] ?? 0);
  // What the provider said, as it said it (credits, quota, an unknown model…): sorting it into causes guessed wrong.
  const said = failure.replace(/^Embeddings failed \(\d{3}\): /, "");
  const at = shownAddress(endpoint.baseUrl);
  const after = "Search by meaning and duplicates will fail until it's fixed.";
  log.error(
    status === 401 || status === 403
      ? `The AI provider at ${at} turned down OPENAI_API_KEY for embeddings (${status}): the key looks wrong. ${after}`
      : status === 0
        ? // fetch's own error can quote the whole address, credentials included: never logged.
          `Couldn't reach ${at} to embed: check the address (OPENAI_BASE_URL). ${after}`
        : `Embedding at ${at} failed (${status}): ${said}. Tuti asks for ${embeddingModelId(endpoint)}, OpenAI's ${EMBEDDING_MODEL}. ${after}`,
  );
}

export async function checkAiProvider(): Promise<void> {
  // The old names (one release, until OPENAI_API_KEY replaced them) are no longer read: one line, so their AI being off has a reason.
  if (process.env.OPENROUTER_API_KEY || process.env.OPENROUTER_BASE_URL) {
    log.warn("OPENROUTER_API_KEY and OPENROUTER_BASE_URL are no longer read: set OPENAI_API_KEY (an OpenRouter key, or another OpenAI-compatible provider's with OPENAI_BASE_URL) instead.");
  }
  if (aiSetup() === "openai-embeddings-only") {
    log.warn(
      "OPENAI_API_KEY is used for embeddings only, on OpenAI; chat is off. To use one provider for everything, set OPENAI_BASE_URL (e.g. https://openrouter.ai/api/v1 with an OpenRouter key).",
    );
  }
  // Chat and embeddings share one address.
  const chat = chatEndpoint();
  const embeddings = embeddingsEndpoint();
  if (embeddings.apiKey && !webAddress(embeddings.baseUrl)) {
    log.error(`OPENAI_BASE_URL isn't a URL (it needs https://…): AI won't work until it's fixed`);
    return;
  }
  if (chat.apiKey && !decisionsAvailable()) {
    log.warn(`Autopilot and Verify need OpenRouter's Decisions API; ${webAddress(chat.baseUrl)!.hostname} doesn't have it`);
  }
  // Chat's endpoint (with the models it lists), and embeddings' (alone when chat is off).
  const models = chat.apiKey ? await checkEndpoint(chat) : null;
  // Embeddings too, even at chat's endpoint: a provider may not serve the embedding model. Not when chat's same
  // endpoint was just turned down: that error has been said once.
  const same = embeddings.apiKey === chat.apiKey && embeddings.baseUrl === chat.baseUrl;
  if (embeddings.apiKey && (!same || models)) {
    await checkEmbeddings(embeddings);
  }
  if (!models) {
    return;
  }
  const json = (await models.json().catch(() => null)) as { data?: { id?: unknown }[] } | null;
  const listed = new Set(Array.isArray(json?.data) ? json.data.map((model) => model?.id) : []);
  // Not code changes' model where Autopilot can't run (no Decisions API): nothing would ask it.
  const used = AI_FEATURES.filter((feature) => feature !== "code_changes" || codeChangesEnabled());
  const missing = [...new Set(used.map(defaultModel))].filter((id) => !listed.has(id));
  if (missing.length > 0) {
    log.error(
      `The AI provider at ${shownAddress(chat.baseUrl)} doesn't list the chat model ${missing.join(", ")}: set AI_MODEL (or a feature's AI_MODEL_<FEATURE>) to a model it serves. AI features using it will fail until then.`,
    );
  }
  // The docs agent's own models, on every merged pull request where Autopilot runs.
  if (codeChangesEnabled()) {
    const { decide, redecide } = codeChangesSettings();
    const agent = [
      ["CODE_CHANGES_DECIDE_MODEL", decide.model],
      ["CODE_CHANGES_REDECIDE_MODEL", redecide.model],
    ].filter(([, id]) => id !== "off" && !listed.has(id));
    for (const [name, id] of agent) {
      log.error(`The AI provider at ${shownAddress(chat.baseUrl)} doesn't list the chat model ${id}: set ${name} to a model it serves. Autopilot's analyses will fail until then.`);
    }
  }
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
 * The decision model, apart from the writing model: CODE_CHANGES_DECISIONS_MODEL (or DECISION_MODEL), by
 * default the one that did best on code changes' evaluation set (`pnpm test:live`; 2026-10-23, among
 * OpenRouter's decision models).
 */
export const DEFAULT_DECISION_MODEL = CODE_CHANGES_SETTINGS.decisions.model.default;

export function decisionModel(): string {
  return codeChangesSettings().decisions.model;
}

/** A bounded question for the decision model: yes or no ("noul"), or one of a few named options. */
export type DecisionQuestion =
  | { type: "noul"; instructions: string; criteria: { true: string; false: string } }
  | { type: "choice"; instructions: string; criteria: Record<string, string> };

/** Its answer: the probability of yes, or each option's probability (and the likeliest). */
export type DecisionAnswer = { type: "noul"; noul: number } | { type: "choice"; choice: string; probabilities: Record<string, number> };

/**
 * Asks the decision model (decisionModel) about `state` through OpenRouter's Decisions API (beside
 * the chat API: /api/alpha/decisions for /api/v1; only OpenRouter has it). Decision models only answer, with calibrated
 * probabilities: no text. Throws on any failure (an endpoint that can't serve the model too), or if a
 * question comes back unanswered.
 */
export async function decide(
  state: unknown,
  questions: Record<string, DecisionQuestion>,
  { timeoutMs = 30_000, meter }: { timeoutMs?: number; meter: Meter },
): Promise<Record<string, DecisionAnswer>> {
  const apiKey = chatKey();
  const response = await fetch(new URL("../alpha/decisions", `${baseUrl()}/`), {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: decisionModel(), state, questions, provider: PROVIDER }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const json = (await response.json().catch(() => null)) as {
    model?: unknown;
    answers?: Record<string, unknown>;
    usage?: { input_tokens?: unknown; output_tokens?: unknown } & Parameters<typeof replyCost>[0];
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
    cost: replyCost(json?.usage),
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
