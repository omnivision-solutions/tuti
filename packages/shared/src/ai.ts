/**
 * Text generation through an OpenAI-compatible chat completions API: OpenRouter
 * by default, or any compatible endpoint (OPENROUTER_BASE_URL). Optional: without
 * OPENROUTER_API_KEY, AI features are off.
 */
export const DEFAULT_AI_MODEL = "anthropic/claude-haiku-5.5";
const DEFAULT_BASE_URL = "https://openrouter.ai/api/v1";

export function aiEnabled(): boolean {
  return Boolean(process.env.OPENROUTER_API_KEY);
}

/** The model's reply to one system and one user message. Throws on any failure, with the reason. */
export async function complete({
  system,
  user,
  maxTokens = 4000,
  timeoutMs = 60_000,
}: {
  system: string;
  user: string;
  maxTokens?: number;
  timeoutMs?: number;
}): Promise<string> {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    throw new Error("OPENROUTER_API_KEY is not set");
  }
  const baseUrl = process.env.OPENROUTER_BASE_URL || DEFAULT_BASE_URL;
  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: process.env.AI_MODEL || DEFAULT_AI_MODEL,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      max_tokens: maxTokens,
    }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const json = (await response.json().catch(() => null)) as {
    choices?: { message?: { content?: unknown } }[];
    error?: { message?: string };
  } | null;
  if (!response.ok) {
    throw new Error(`AI request failed (${response.status}): ${json?.error?.message ?? "no details"}`);
  }
  const content = json?.choices?.[0]?.message?.content;
  if (typeof content !== "string" || content.trim() === "") {
    throw new Error("The AI reply had no text");
  }
  return content;
}
