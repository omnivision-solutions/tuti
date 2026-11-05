/**
 * The AI provider: one OpenAI-compatible endpoint for chat, embeddings and (on OpenRouter) decisions,
 * OPENAI_BASE_URL with OPENAI_API_KEY. Resolved in this order:
 *
 * 1. OPENROUTER_API_KEY set (deprecated, for one release): as before. Chat and decisions through
 *    OPENROUTER_BASE_URL (OpenRouter by default); embeddings with OPENAI_API_KEY, if set.
 * 2. Else OPENAI_BASE_URL set: everything through it, with OPENAI_API_KEY.
 * 3. Else an OpenRouter key (sk-or-…) in OPENAI_API_KEY: everything through OpenRouter.
 * 4. Else OPENAI_API_KEY set: its old meaning, an OpenAI key for embeddings only; chat stays off, so
 *    the key is never sent anywhere but OpenAI.
 * 5. Neither key: AI is off.
 *
 * Embeddings, in every case: at OPENAI_BASE_URL if set, else OpenRouter for an OpenRouter key, else OpenAI.
 */
export type Endpoint = {
  apiKey: string | undefined;
  baseUrl: string;
  /** The variables it comes from, to name in messages. */
  keyName: string;
  urlName: string;
};

const OPENROUTER_URL = "https://openrouter.ai/api/v1";
const OPENAI_URL = "https://api.openai.com/v1";

const trim = (url: string) => url.replace(/\/+$/, "");

export type Setup = "openrouter-legacy" | "one-provider" | "openai-embeddings-only" | "off";

export function aiSetup(): Setup {
  const env = process.env;
  if (env.OPENROUTER_API_KEY) return "openrouter-legacy";
  if (env.OPENAI_API_KEY && (env.OPENAI_BASE_URL || env.OPENAI_API_KEY.startsWith("sk-or-"))) return "one-provider";
  if (env.OPENAI_API_KEY) return "openai-embeddings-only";
  return "off";
}

/** Where chat, the models list and decisions go; no key when chat is off (cases 4 and 5). */
export function chatEndpoint(): Endpoint {
  switch (aiSetup()) {
    case "openrouter-legacy":
      return { apiKey: process.env.OPENROUTER_API_KEY, baseUrl: trim(process.env.OPENROUTER_BASE_URL || OPENROUTER_URL), keyName: "OPENROUTER_API_KEY", urlName: "OPENROUTER_BASE_URL" };
    case "one-provider":
      return embeddingsEndpoint();
    default:
      return { ...embeddingsEndpoint(), apiKey: undefined };
  }
}

/** Where embeddings go. */
export function embeddingsEndpoint(): Endpoint {
  const apiKey = process.env.OPENAI_API_KEY || undefined;
  const fallback = apiKey?.startsWith("sk-or-") ? OPENROUTER_URL : OPENAI_URL;
  return { apiKey, baseUrl: trim(process.env.OPENAI_BASE_URL || fallback), keyName: "OPENAI_API_KEY", urlName: "OPENAI_BASE_URL" };
}

export const isOpenRouter = (endpoint: Endpoint) => new URL(endpoint.baseUrl).hostname === "openrouter.ai";
