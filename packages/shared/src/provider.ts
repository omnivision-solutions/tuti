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

/**
 * An AI request (chat, decisions, embeddings) the provider never answered, so asking again later may get an answer: its
 * time limit passed, there was no connection or it was cut while the reply came, or the provider said it can't answer
 * now (408, 429, 5xx). Thrown by the AI clients only, so a failure elsewhere (GitHub's) is never taken for one. Not a
 * refusal (400, 401, 402, 403), nor a reply that came, was paid for, and couldn't be used (empty, not JSON): asked
 * again, those fail the same way.
 */
export class ProviderDidNotAnswer extends Error {
  override name = "ProviderDidNotAnswer";
}

/** A time limit, or fetch's own failures (no connection, the connection cut while the reply came). */
const unanswered = (error: unknown) =>
  (error as { name?: unknown } | null)?.name === "TimeoutError" || (error instanceof TypeError && /^(fetch failed|terminated)$/.test(error.message));

/**
 * fetch for an AI request, with its reply's body as JSON (null when the body isn't JSON). A request that got no answer
 * throws ProviderDidNotAnswer (with fetch's error as its cause, and its words).
 */
export async function askProvider<T>(url: string | URL, init: RequestInit): Promise<{ response: Response; json: T | null }> {
  try {
    const response = await fetch(url, init);
    const json = (await response.json().catch((error: unknown) => {
      if (unanswered(error)) {
        throw error;
      }
      return null;
    })) as T | null;
    return { response, json };
  } catch (error) {
    throw unanswered(error) ? new ProviderDidNotAnswer((error as Error).message, { cause: error }) : error;
  }
}

/** An AI request's failure status, in `what`'s words ("AI request failed (503): …"): ProviderDidNotAnswer for 408, 429 and 5xx. */
export function requestFailed(what: string, status: number, details: string): Error {
  const message = `${what} (${status}): ${details}`;
  return status === 408 || status === 429 || status >= 500 ? new ProviderDidNotAnswer(message) : new Error(message);
}
