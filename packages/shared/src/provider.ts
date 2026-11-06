/**
 * The AI provider: one OpenAI-compatible endpoint for chat, embeddings and (on OpenRouter) decisions,
 * OPENAI_BASE_URL with OPENAI_API_KEY. Resolved in this order:
 *
 * 1. OPENAI_BASE_URL set: everything through it, with OPENAI_API_KEY.
 * 2. Else an OpenRouter key (sk-or-…) in OPENAI_API_KEY: everything through OpenRouter.
 * 3. Else OPENAI_API_KEY set: its old meaning, an OpenAI key for embeddings only; chat stays off, so
 *    the key is never sent anywhere but OpenAI.
 * 4. No key: AI is off.
 *
 * Embeddings, in every case: at OPENAI_BASE_URL if set, else OpenRouter for an OpenRouter key, else OpenAI.
 */
export type Endpoint = {
  apiKey: string | undefined;
  baseUrl: string;
};

const OPENROUTER_URL = "https://openrouter.ai/api/v1";
const OPENAI_URL = "https://api.openai.com/v1";

const trim = (url: string) => url.replace(/\/+$/, "");

export type Setup = "one-provider" | "openai-embeddings-only" | "off";

export function aiSetup(): Setup {
  const env = process.env;
  if (env.OPENAI_API_KEY && (env.OPENAI_BASE_URL || env.OPENAI_API_KEY.startsWith("sk-or-"))) return "one-provider";
  if (env.OPENAI_API_KEY) return "openai-embeddings-only";
  return "off";
}

/** Where chat, the models list and decisions go; no key when chat is off (cases 3 and 4). */
export function chatEndpoint(): Endpoint {
  return aiSetup() === "one-provider" ? embeddingsEndpoint() : { ...embeddingsEndpoint(), apiKey: undefined };
}

/** Where embeddings go. */
export function embeddingsEndpoint(): Endpoint {
  const apiKey = process.env.OPENAI_API_KEY || undefined;
  const fallback = apiKey?.startsWith("sk-or-") ? OPENROUTER_URL : OPENAI_URL;
  return { apiKey, baseUrl: trim(process.env.OPENAI_BASE_URL || fallback) };
}

/** The address as an http(s) URL with a host, or null: `llm.example.com:8080/v1` parses, but as a scheme, not a host. */
export function webAddress(address: string): URL | null {
  const url = URL.canParse(address) ? new URL(address) : null;
  return url && (url.protocol === "http:" || url.protocol === "https:") && url.hostname ? url : null;
}

// An address that isn't one isn't OpenRouter (the start-up check says what's wrong with it).
export const isOpenRouter = (endpoint: Endpoint) => webAddress(endpoint.baseUrl)?.hostname === "openrouter.ai";

/** Requests go through OpenRouter: at its address, or with its key elsewhere (a proxy in front of it). Only then may they carry its own fields. */
export const throughOpenRouter = (endpoint: Endpoint) => isOpenRouter(endpoint) || Boolean(endpoint.apiKey?.startsWith("sk-or-"));

/**
 * Whether chat's endpoint has OpenRouter's Decisions API, which Autopilot and Verify need: OpenRouter
 * itself, or anything reached with an OpenRouter key (sk-or-…: a proxy in front of OpenRouter, or the
 * tests' fake).
 */
export function decisionsAvailable(): boolean {
  const chat = chatEndpoint();
  return Boolean(chat.apiKey) && throughOpenRouter(chat);
}
