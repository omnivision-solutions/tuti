import { afterEach, beforeEach, expect, test } from "vitest";

import { FAKE_MODEL_KEY, type ModelFake, startModelFake } from "./model-fake";

let model: ModelFake;
beforeEach(async () => {
  model = await startModelFake();
});
afterEach(() => model.close());

const chat = async (body: unknown) =>
  (await (
    await fetch(`${model.url}/chat/completions`, {
      method: "POST",
      headers: { authorization: `Bearer ${FAKE_MODEL_KEY}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    })
  ).json()) as { choices: { finish_reason: string; message: { content: string | null; tool_calls?: unknown[] } }[] };

const tools = [{ type: "function", function: { name: "read_file", parameters: { type: "object", properties: { path: { type: "string" } } } } }];

test("a scripted step answers with tool calls; each request's messages (tool results included) and tools are recorded", async () => {
  model.toolCalls([{ id: "call_a", name: "read_file", arguments: '{"path":"src/app.ts"}' }, { name: "read_file", arguments: '{"path":"b.ts"}' }]);
  model.reply("Done");
  const first = [
    { role: "system", content: "You read code." },
    { role: "user", content: "What changed?" },
  ];
  const answer = await chat({ model: "acme/tiny", messages: first, tools });
  expect(answer.choices[0]).toEqual({
    index: 0,
    finish_reason: "tool_calls",
    message: {
      role: "assistant",
      content: null,
      tool_calls: [
        { id: "call_a", type: "function", function: { name: "read_file", arguments: '{"path":"src/app.ts"}' } },
        { id: "call_1_1", type: "function", function: { name: "read_file", arguments: '{"path":"b.ts"}' } },
      ],
    },
  });
  const second = [
    ...first,
    answer.choices[0]!.message,
    { role: "tool", tool_call_id: "call_a", content: "export const a = 1;" },
    { role: "tool", tool_call_id: "call_1_1", content: "There's no file at b.ts in the repository." },
  ];
  expect((await chat({ model: "acme/tiny", messages: second, tools })).choices[0]).toMatchObject({ finish_reason: "stop", message: { content: "Done" } });
  expect(model.requests).toEqual([
    { model: "acme/tiny", system: "You read code.", user: "What changed?", messages: first, tools },
    { model: "acme/tiny", system: "You read code.", user: "What changed?", messages: second, tools },
  ]);
  model.done();
});

test("an unused tool-call step is reported", () => {
  model.toolCalls([{ name: "list_files", arguments: "{}" }]);
  expect(() => model.done()).toThrow("an unused step: tool calls list_files");
});

test("like Anthropic's API, a conversation holding tool calls or their answers must declare the tools", async () => {
  const messages = [
    { role: "system", content: "You read code." },
    { role: "user", content: "What changed?" },
    { role: "assistant", content: null, tool_calls: [{ id: "call_a", type: "function", function: { name: "read_file", arguments: "{}" } }] },
    { role: "tool", tool_call_id: "call_a", content: "export const a = 1;" },
  ];
  const response = await fetch(`${model.url}/chat/completions`, {
    method: "POST",
    headers: { authorization: `Bearer ${FAKE_MODEL_KEY}`, "content-type": "application/json" },
    body: JSON.stringify({ model: "acme/tiny", messages }),
  });
  expect(response.status).toBe(400);
  expect(() => model.done()).toThrow("a request with tool calls in its messages but no tools declared");
  // Declared, with tool_choice none: answered.
  model.reply("Done");
  expect((await chat({ model: "acme/tiny", messages, tools, tool_choice: "none" })).choices[0]!.message.content).toBe("Done");
  expect(model.requests.at(-1)).toMatchObject({ toolChoice: "none" });
});
