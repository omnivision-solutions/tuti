import { answeredBy, type Meter, replyCost, tokens } from "./usage";

/**
 * A conversation with tools, beside `complete()` (one system and one user message): OpenAI's chat completions format,
 * with `tools` offered, the model's `tool_calls`, and each tool's answer as a `role: "tool"` message. Each request is
 * metered to the project like `complete()`'s, and has its own time limit; `signal` ends it sooner (an analysis's own).
 * ponytail: the endpoint as `complete()` reads it today; one AI provider (docs/plan.md, D1) gives both one place.
 */
export type ToolCall = { id: string; type: "function"; function: { name: string; arguments: string } };
export type ChatMessage =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: ToolCall[]; reasoning_details?: unknown }
  | { role: "tool"; tool_call_id: string; content: string };
/** A tool the model may call, in OpenAI's function-calling format. */
export type ChatTool = { type: "function"; function: { name: string; description: string; parameters: unknown } };
/** How much the model thinks before it answers (OpenRouter's reasoning effort); off asks for none. */
export type Reasoning = "off" | "low" | "medium" | "high";

/** The model's turn: its text (empty when it only called tools) and its tool calls, as a message to send back. */
export type ChatReply = { content: string; toolCalls: ToolCall[]; message: Extract<ChatMessage, { role: "assistant" }> };

const DEFAULT_BASE_URL = "https://openrouter.ai/api/v1";

/** Throws on any failure (a time limit included), with the reason. */
export async function chat({
  model,
  messages,
  tools,
  toolChoice,
  maxTokens,
  temperature,
  reasoning = "off",
  timeoutMs,
  signal,
  meter,
}: {
  model: string;
  messages: ChatMessage[];
  tools?: ChatTool[];
  /** "none": the model must answer, not call the tools (still declared, as a conversation that used them must). */
  toolChoice?: "none";
  maxTokens: number;
  temperature?: number;
  reasoning?: Reasoning;
  timeoutMs: number;
  signal?: AbortSignal;
  meter: Meter;
}): Promise<ChatReply> {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    throw new Error("OPENROUTER_API_KEY is not set");
  }
  const baseUrl = (process.env.OPENROUTER_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, "");
  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      messages,
      ...(tools && tools.length > 0 && { tools, ...(toolChoice && { tool_choice: toolChoice }) }),
      max_tokens: maxTokens,
      ...(temperature !== undefined && { temperature }),
      ...(reasoning !== "off" && { reasoning: { effort: reasoning } }),
      // As complete() asks: providers that neither train on prompts nor keep them, and what the request cost.
      provider: { data_collection: "deny" },
      usage: { include: true },
    }),
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs),
  });
  const json = (await response.json().catch(() => null)) as {
    model?: unknown;
    choices?: { message?: { content?: unknown; tool_calls?: unknown; reasoning_details?: unknown } }[];
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
  const message = json?.choices?.[0]?.message;
  const content = typeof message?.content === "string" ? message.content : "";
  const toolCalls = (Array.isArray(message?.tool_calls) ? (message.tool_calls as Partial<ToolCall>[]) : [])
    .filter((call) => typeof call?.id === "string" && typeof call.function?.name === "string")
    .map((call) => ({ id: call.id!, type: "function" as const, function: { name: call.function!.name, arguments: typeof call.function!.arguments === "string" ? call.function!.arguments : "" } }));
  return {
    content,
    toolCalls,
    // Sent back as it came: a model that thought before calling tools needs its reasoning with their answers.
    message: { role: "assistant", content: content || null, ...(toolCalls.length > 0 && { tool_calls: toolCalls }), ...(message?.reasoning_details !== undefined && { reasoning_details: message.reasoning_details }) },
  };
}
