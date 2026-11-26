import { CODE_CHANGES_SETTINGS, codeChangesSettings, serverCodeChangesSettings } from "./code-changes-settings";
import { config } from "./config";
import { embed, EMBEDDING_MODEL, embeddingModelId, embeddingsEnabled } from "./embeddings";
import { log } from "./log";
import { aiSetup, askProvider, chatEndpoint, decisionsAvailable, embeddingsEndpoint, isOpenRouter, ProviderDidNotAnswer, requestFailed, throughOpenRouter, webAddress } from "./provider";
import { answeredBy, dollars, type Meter, replyCost, tokens } from "./usage";

/**
 * Text generation through an OpenAI-compatible chat completions API: OpenRouter by default, or any
 * compatible endpoint (where: ./provider). Optional: without a key, AI features are off.
 */
export const DEFAULT_AI_MODEL = "anthropic/claude-haiku-5.5";
/** Translation's own default (the Inbox's conversations; docs/plan.md, Languages), chosen by an evaluation of translations. */
export const DEFAULT_TRANSLATION_MODEL = "openai/gpt-6.1-terra";

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
export const AI_FEATURES = ["answers", "escalations", "changelog", "code_changes", "support", "translation"] as const;
export type AiFeature = (typeof AI_FEATURES)[number];

/**
 * What AI usage is recorded and charged for: the features, duplicate detection (its model is the server's, from the
 * config file), screenshots (an agent in Browser Use's cloud browser, charged what its session cost) and images (generateImage).
 */
export const USAGE_FEATURES = [...AI_FEATURES, "duplicates", "screenshots", "images"] as const;
export type UsageFeature = (typeof USAGE_FEATURES)[number];

/**
 * A role is one kind of work a model does for a feature, and what a project picks a model for (each feature's page under Settings → AI).
 * Code asks for a role, never a model: a feature's steps can be added, removed or reordered without a new setting,
 * as long as each names the role it works in. `feature` is what its requests are metered as; `tools`: an agent's
 * role, so only models with tool calls; `off`: a role a project may switch off.
 * Autopilot has three: code_changes_decide (Decides: reads a lot and judges, at volume), code_changes (Writes: the text,
 * Verify's too) and code_changes_check (Checks: a second opinion on another step's work, today the new-article
 * double-check). The Inbox has two: drafting a reply, and summarising a conversation. Translation (conversations, L22) is its own.
 */
export const AI_ROLES = {
  answers: { feature: "answers" },
  escalations: { feature: "escalations" },
  support_draft: { feature: "support" },
  support_summary: { feature: "support" },
  changelog: { feature: "changelog" },
  code_changes_decide: { feature: "code_changes", tools: true },
  code_changes_check: { feature: "code_changes", tools: true, off: true },
  code_changes: { feature: "code_changes", tools: true },
  translation: { feature: "translation" },
} as const satisfies Record<string, { feature: AiFeature; tools?: true; off?: true }>;
export type AiRole = keyof typeof AI_ROLES;
export const AI_ROLE_NAMES = Object.keys(AI_ROLES) as AiRole[];

/** Whether a role's model must take tool calls, and whether a project may switch the role off. */
export const roleNeedsTools = (role: AiRole) => "tools" in AI_ROLES[role];
export const roleCanBeOff = (role: AiRole) => "off" in AI_ROLES[role];

/**
 * A role's model for every project: Autopilot's Decides and Checks are the server's autopilot.decide.model and
 * autopilot.redecide.model (the config file); any other is its feature's (defaultModel).
 */
export function roleDefaultModel(role: AiRole): string {
  if (role === "code_changes_decide") {
    return serverCodeChangesSettings().decide.model;
  }
  if (role === "code_changes_check") {
    return serverCodeChangesSettings().redecide.model;
  }
  return defaultModel(AI_ROLES[role].feature);
}

/**
 * A feature's model for every project: the config file's ai.features.<feature> (e.g. ai.features.answers, a model id),
 * else ai.model, else Tuti's default (for code changes, Autopilot's write model: autopilot.write.model; for translation, DEFAULT_TRANSLATION_MODEL).
 */
export function defaultModel(feature: AiFeature): string {
  const { model, features } = config().ai;
  const builtIn = feature === "code_changes" ? codeChangesSettings().write.model : feature === "translation" ? DEFAULT_TRANSLATION_MODEL : DEFAULT_AI_MODEL;
  return features[feature === "code_changes" ? "codeChanges" : feature] ?? model ?? builtIn;
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
  const { response, json } = await askProvider<{
    model?: unknown;
    choices?: { message?: { content?: unknown } }[];
    usage?: { prompt_tokens?: unknown; completion_tokens?: unknown } & Parameters<typeof replyCost>[0];
    error?: { message?: string };
  }>(`${baseUrl()}/chat/completions`, {
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
  if (!response.ok) {
    throw requestFailed("AI request failed", response.status, json?.error?.message ?? "no details");
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

/** Whether `error`, thrown by complete, chat, decide or embed, means the AI provider didn't answer (ProviderDidNotAnswer). */
export function providerDidNotAnswer(error: unknown): boolean {
  return error instanceof ProviderDidNotAnswer;
}

/**
 * A model the endpoint serves (OpenRouter's GET /models), with its price in dollars per token when it says, and whether
 * it takes tool calls (OpenRouter's `supported_parameters` has "tools"; true where the endpoint doesn't say).
 */
export type AiModelListing = { id: string; name: string; input: number | null; output: number | null; tools: boolean };

/** The endpoint's models. Throws on any failure. */
export async function listModels(): Promise<AiModelListing[]> {
  const apiKey = chatKey();
  const response = await fetch(`${baseUrl()}/models`, { headers: { Authorization: `Bearer ${apiKey}` }, signal: AbortSignal.timeout(10_000) });
  type Listed = { id: string; name?: unknown; pricing?: { prompt?: unknown; completion?: unknown }; supported_parameters?: unknown };
  const json = (await response.json().catch(() => null)) as { data?: Partial<Listed>[] } | null;
  if (!response.ok || !Array.isArray(json?.data)) {
    throw new Error(`Listing the AI models failed (${response.status})`);
  }
  // OpenRouter's prices are strings of dollars per token.
  const price = (value: unknown) => dollars(typeof value === "string" ? Number(value) : value);
  return json.data
    .filter((model): model is Listed => typeof model.id === "string" && model.id !== "")
    .map((model) => ({
      id: model.id,
      name: typeof model.name === "string" ? model.name : model.id,
      input: price(model.pricing?.prompt),
      output: price(model.pricing?.completion),
      tools: !Array.isArray(model.supported_parameters) || model.supported_parameters.includes("tools"),
    }));
}

/**
 * At start-up (web and worker): says what the setup keeps from before, then asks the endpoint for its
 * models and logs one error if that fails, saying whether the key or the address looks wrong, or if it
 * doesn't list a chat model the server uses (ai.model, a feature's, or Tuti's default). Never throws:
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
      `The AI provider at ${shownAddress(chat.baseUrl)} doesn't list the chat model ${missing.join(", ")}: set ai.model (or a feature's ai.features.<feature>) in the config file to a model it serves. AI features using it will fail until then.`,
    );
  }
  // The docs agent's own models, on every merged pull request where Autopilot runs.
  if (codeChangesEnabled()) {
    const { decide, redecide } = codeChangesSettings();
    const agent = [
      ["autopilot.decide.model", decide.model],
      ["autopilot.redecide.model", redecide.model],
    ].filter(([, id]) => id !== "off" && !listed.has(id));
    for (const [name, id] of agent) {
      log.error(`The AI provider at ${shownAddress(chat.baseUrl)} doesn't list the chat model ${id}: set ${name} in the config file to a model it serves. Autopilot's analyses will fail until then.`);
    }
  }
}

/** The operator's cap on the models projects may pick (the config file's ai.maxPrice, dollars per million output tokens), or null for none. */
export const modelMaxPrice = (): number | null => config().ai.maxPrice;

/** Whether a project may pick `model` under modelMaxPrice: any model without a cap; with one, only a model with a price at or under it. */
export function withinModelCap(model: AiModelListing): boolean {
  const cap = modelMaxPrice();
  // Compared in millionths of a dollar per million tokens, so a price written like the cap isn't over it by a rounding error.
  return cap === null || (model.output !== null && Math.round(model.output * 1e12) <= Math.round(cap * 1e6));
}

/**
 * The decision model, apart from the writing model: autopilot.decisions.model in the config file, by
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
 * Asks the decision model (`model`, by default Autopilot's: decisionModel) about `state` through OpenRouter's Decisions API (beside
 * the chat API: /api/alpha/decisions for /api/v1; only OpenRouter has it). Decision models only answer, with calibrated
 * probabilities: no text. Throws on any failure (an endpoint that can't serve the model too), or if a
 * question comes back unanswered.
 */
export async function decide(
  state: unknown,
  questions: Record<string, DecisionQuestion>,
  { timeoutMs = 30_000, meter, model = decisionModel() }: { timeoutMs?: number; meter: Meter; model?: string },
): Promise<Record<string, DecisionAnswer>> {
  const apiKey = chatKey();
  const { response, json } = await askProvider<{
    model?: unknown;
    answers?: Record<string, unknown>;
    usage?: { input_tokens?: unknown; output_tokens?: unknown } & Parameters<typeof replyCost>[0];
    error?: { message?: string };
  }>(new URL("../alpha/decisions", `${baseUrl()}/`), {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model, state, questions, provider: PROVIDER }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) {
    throw requestFailed("Decision request failed", response.status, json?.error?.message ?? "no details");
  }
  await meter({
    kind: "decision",
    model: answeredBy(json?.model, model),
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

/** Whether screenshots work on this server: a Browser Use key (BROWSER_USE_API_KEY). */
export function screenshotsEnabled(): boolean {
  return Boolean(process.env.BROWSER_USE_API_KEY?.trim());
}

/** AI images' model (docs/plan.md, AI image generator): the config file's ai.imageModel, by default DEFAULT_IMAGE_MODEL. */
export const imageModel = () => config().ai.imageModel;

/** The aspect ratios it makes (OpenRouter's image_config.aspect_ratio). */
export const IMAGE_RATIOS = ["1:1", "1:4", "1:8", "2:3", "3:2", "3:4", "4:1", "4:3", "4:5", "5:4", "8:1", "9:16", "16:9", "21:9"] as const;

/** Its resolutions (image_config.image_size): 1K is about a 1024×1024 image's pixels in its ratio (16:9 came back 1376×768), 2K and 4K twice and four times as wide and tall. */
const IMAGE_SIZES = [
  ["1K", 1],
  ["2K", 2],
  ["4K", 4],
] as const;

/** Cropping off more than this share of what the model makes asks it to keep what matters clear of those edges. */
const NOTABLE_CROP = 0.05;

/**
 * What to ask the model for an image of `width` × `height`: the aspect ratio closest to it (compared in log space, so
 * 2:1 is as far from 1:1 as 1:2 is), the smallest resolution whose image still holds the size once cropped to it (4K
 * where none does), and which edges the crop takes off when it takes off much.
 */
export function imageShape(width: number, height: number): { aspectRatio: (typeof IMAGE_RATIOS)[number]; imageSize: "1K" | "2K" | "4K"; cropped: "top and bottom" | "left and right" | null } {
  const ratioOf = (name: string) => {
    const [w, h] = name.split(":").map(Number);
    return w! / h!;
  };
  const wanted = width / height;
  const distance = (name: string) => Math.abs(Math.log(ratioOf(name) / wanted));
  const aspectRatio = IMAGE_RATIOS.reduce((best, name) => (distance(name) < distance(best) ? name : best));
  const ratio = ratioOf(aspectRatio);
  // The model's image, about 1024² pixels a step in its ratio; cropped to width:height, it keeps all of one side.
  const holds = (scale: number) => Math.min((1024 * scale * Math.sqrt(ratio)) / width, (1024 * scale) / Math.sqrt(ratio) / height) >= 1;
  const imageSize = (IMAGE_SIZES.find(([, scale]) => holds(scale)) ?? IMAGE_SIZES[2])[0];
  const kept = Math.min(ratio, wanted) / Math.max(ratio, wanted);
  return { aspectRatio, imageSize, cropped: 1 - kept <= NOTABLE_CROP ? null : wanted > ratio ? "top and bottom" : "left and right" };
}

/** Whether AI images work on this server: OpenRouter's image models need OpenRouter, as its Decisions API does. */
export const imagesEnabled = decisionsAvailable;

/**
 * One image from the image model (imageModel): `prompt`, with `references` (data URLs) to work from, in an aspect ratio and resolution
 * it makes (imageShape). Its bytes as it sent them (PNG or JPEG). Throws on any failure, with the reason.
 */
export async function generateImage({
  prompt,
  references,
  aspectRatio,
  imageSize,
  meter,
  timeoutMs = 120_000,
}: {
  prompt: string;
  references: string[];
  aspectRatio: string;
  imageSize: string;
  meter: Meter;
  timeoutMs?: number;
}): Promise<Buffer> {
  const apiKey = chatKey();
  const model = imageModel();
  const { response, json } = await askProvider<{
    model?: unknown;
    choices?: { message?: { images?: { image_url?: { url?: unknown } }[] } }[];
    usage?: { prompt_tokens?: unknown; completion_tokens?: unknown } & Parameters<typeof replyCost>[0];
    error?: { message?: string };
  }>(`${baseUrl()}/chat/completions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      messages: [{ role: "user", content: [{ type: "text", text: prompt }, ...references.map((url) => ({ type: "image_url", image_url: { url } }))] }],
      modalities: ["image", "text"],
      image_config: { aspect_ratio: aspectRatio, image_size: imageSize },
      provider: PROVIDER,
      usage: { include: true },
    }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) {
    throw requestFailed("Image request failed", response.status, json?.error?.message ?? "no details");
  }
  await meter({
    kind: "chat",
    model: answeredBy(json?.model, model),
    inputTokens: tokens(json?.usage?.prompt_tokens),
    outputTokens: tokens(json?.usage?.completion_tokens),
    cost: replyCost(json?.usage),
  });
  const url = json?.choices?.[0]?.message?.images?.[0]?.image_url?.url;
  const data = typeof url === "string" ? /^data:image\/[a-z]+;base64,([^,]+)$/.exec(url)?.[1] : undefined;
  if (!data) {
    throw new Error("The AI reply had no image");
  }
  return Buffer.from(data, "base64");
}
