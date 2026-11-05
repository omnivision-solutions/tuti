import { type ModelFake, startModelFake } from "@tuti/testkit";
import { afterAll, afterEach, beforeAll, beforeEach, expect, test, vi } from "vitest";

import { chat, type ChatMessage } from "./chat";
import type { AiUsage } from "./usage";

let model: ModelFake;
beforeAll(async () => {
  model = await startModelFake();
});
afterAll(() => model.close());
beforeEach(() => {
  for (const [name, value] of Object.entries(model.env)) {
    vi.stubEnv(name, value);
  }
  model.requests.splice(0);
});
afterEach(() => {
  vi.unstubAllEnvs();
  model.done();
});

const meter = async () => {};
const tools = [{ type: "function" as const, function: { name: "read_file", description: "A file", parameters: { type: "object", properties: { path: { type: "string" } } } } }];
const start: ChatMessage[] = [
  { role: "system", content: "You read code." },
  { role: "user", content: "What changed?" },
];

test("a conversation with tools: the model's tool calls, sent back with their answers, then its reply; each request metered", async () => {
  const usage: AiUsage[] = [];
  const record = async (used: AiUsage) => void usage.push(used);
  model.toolCalls([{ id: "call_a", name: "read_file", arguments: '{"path":"src/app.ts"}' }]);
  const first = await chat({ model: "acme/tiny", messages: start, tools, maxTokens: 1_000, temperature: 0, reasoning: "low", timeoutMs: 5_000, meter: record });
  expect(first).toEqual({
    content: "",
    toolCalls: [{ id: "call_a", type: "function", function: { name: "read_file", arguments: '{"path":"src/app.ts"}' } }],
    message: { role: "assistant", content: null, tool_calls: [{ id: "call_a", type: "function", function: { name: "read_file", arguments: '{"path":"src/app.ts"}' } }] },
  });
  model.reply("It adds a dark theme.");
  const messages: ChatMessage[] = [...start, first.message, { role: "tool", tool_call_id: "call_a", content: "export const dark = true;" }];
  // Told to answer: the tools still declared (the conversation used them), `tool_choice` none.
  const second = await chat({ model: "acme/tiny", messages, tools, toolChoice: "none", maxTokens: 1_000, timeoutMs: 5_000, meter: record });
  expect(second).toMatchObject({ content: "It adds a dark theme.", toolCalls: [], message: { role: "assistant", content: "It adds a dark theme." } });
  expect(model.requests).toMatchObject([
    { model: "acme/tiny", maxTokens: 1_000, tools, temperature: 0, reasoning: { effort: "low" }, messages: start },
    { model: "acme/tiny", messages, tools, toolChoice: "none" },
  ]);
  // No reasoning asked for: none is sent; nor a tool choice without tools.
  expect(model.requests[1]).not.toHaveProperty("reasoning");
  expect(model.requests[0]).not.toHaveProperty("toolChoice");
  expect(usage).toHaveLength(2);
  expect(usage[0]).toMatchObject({ kind: "chat", model: "acme/tiny" });
});

test("a request over its time limit, or past its signal, fails; so does an error status", async () => {
  // (Its reply waits till the request has given up.)
  let release = () => {};
  const held = new Promise<void>((resolve) => (release = resolve));
  model.reply("Too late", () => held);
  await expect(chat({ model: "acme/tiny", messages: start, maxTokens: 100, timeoutMs: 50, meter })).rejects.toThrow(/timeout|aborted/i);
  release();
  const analysis = new AbortController();
  analysis.abort(new Error("The analysis took too long"));
  // (Aborted before it's sent: nothing reaches the model.)
  await expect(chat({ model: "acme/tiny", messages: start, maxTokens: 100, timeoutMs: 5_000, signal: analysis.signal, meter })).rejects.toThrow("The analysis took too long");
  model.fail(502);
  await expect(chat({ model: "acme/tiny", messages: start, maxTokens: 100, timeoutMs: 5_000, meter })).rejects.toThrow("AI request failed (502)");
});

test("AI is off without a key", async () => {
  vi.unstubAllEnvs();
  vi.stubEnv("OPENROUTER_API_KEY", "");
  await expect(chat({ model: "acme/tiny", messages: start, maxTokens: 100, timeoutMs: 5_000, meter })).rejects.toThrow("OPENROUTER_API_KEY is not set");
});
