import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { crc32, deflateSync } from "node:zlib";

import { FAKE_OPENAI_KEY, type OpenAIFake, startOpenAIFake } from "./openai-fake";

export const FAKE_MODEL_KEY = "sk-or-test-fake";

/**
 * What a request asked: its model, its system and first user message, its token cap, every message (in a conversation
 * with tools: the model's tool calls and each tool's result) and the tools it offered.
 */
export type ModelRequest = {
  model: string;
  system: string;
  user: string;
  maxTokens?: number;
  messages: ModelMessage[];
  tools?: unknown[];
  temperature?: number;
  reasoning?: unknown;
  toolChoice?: unknown;
};

/** A chat message as sent: `tool_calls` on the model's turns that called tools, `tool_call_id` on a tool's result. */
export type ModelMessage = { role: string; content?: unknown; tool_calls?: { id: string; type: string; function: { name: string; arguments: string } }[]; tool_call_id?: string };

/** What an image request asked (a chat completion with `modalities` holding "image"): its model, prompt, reference images (data URLs) and image_config. */
export type ImageRequest = { model: string; prompt: string; references: string[]; aspectRatio?: unknown; imageSize?: unknown; provider?: unknown; usage?: unknown };

/** What the fake charges for an image: a cent at 1K, more at 2K and 4K. */
export const FAKE_IMAGE_COST = { "1K": 0.01, "2K": 0.02, "4K": 0.04 } as Record<string, number>;

/** A tool call a scripted step answers with: its id (by default `call_<n>`), the tool's name and its arguments (JSON text). */
export type FakeToolCall = { id?: string; name: string; arguments: string };

/** What a decision request asked: its model, state and questions (OpenRouter's Decisions API). */
export type DecisionRequest = { model: string; state: unknown; questions: Record<string, { type: string; instructions: unknown; criteria?: unknown }>; provider?: unknown };

/**
 * A scripted decision, per question name: a number answers a yes/no ("noul") question with that
 * probability; an object of probabilities answers a choice question (its choice is the likeliest). `*` answers every
 * question the others don't name.
 */
export type FakeDecision = Record<string, number | Record<string, number>>;

/**
 * The models the fake lists (GET /models, like OpenRouter's), with prices in dollars per token as strings and the
 * parameters they take (`tools` for tool calls); any model id is still answered.
 */
const TOOLS = ["max_tokens", "temperature", "tools", "tool_choice"];
export const FAKE_MODELS = [
  { id: "anthropic/claude-haiku-5.5", name: "Anthropic: Claude Haiku 5.5", pricing: { prompt: "0.000001", completion: "0.000005" }, supported_parameters: TOOLS },
  { id: "anthropic/claude-sonnet-5.5", name: "Anthropic: Claude Sonnet 5.5", pricing: { prompt: "0.000003", completion: "0.000015" }, supported_parameters: TOOLS },
  { id: "anthropic/claude-opus-5.5", name: "Anthropic: Claude Opus 5.5", pricing: { prompt: "0.000005", completion: "0.000025" }, supported_parameters: TOOLS },
  { id: "openai/gpt-6.1-terra", name: "OpenAI: GPT-6.1 Terra", pricing: { prompt: "0.0000004", completion: "0.0000016" }, supported_parameters: TOOLS },
  { id: "acme/tiny", name: "Acme: Tiny", pricing: { prompt: "0.0000001", completion: "0.0000004" }, supported_parameters: TOOLS },
  { id: "acme/no-tools", name: "Acme: No tools", pricing: { prompt: "0.0000001", completion: "0.0000004" }, supported_parameters: ["max_tokens", "temperature"] },
  { id: "acme/no-price", name: "Acme: No price" },
];

/** A scripted answer: a reply (status 200) or an error status. */
type Step = { status: number; content?: string; toolCalls?: FakeToolCall[]; during?: () => Promise<unknown>; match?: string };

export type ModelFake = {
  /** Base URL to use as OPENAI_BASE_URL. */
  url: string;
  /** OPENAI_API_KEY and OPENAI_BASE_URL for an app that uses this fake: chat, decisions and embeddings. */
  env: Record<string, string>;
  /** Where its embeddings come from (`/embeddings` and `/fixtures` are passed on to it). */
  embeddings: OpenAIFake;
  /** Every chat completion request, in order (also `GET /_fake/requests`). */
  requests: ModelRequest[];
  /**
   * The next request gets this reply (steps are used in order). `during` runs while
   * that request waits for it, e.g. a save racing the model. Also `POST /_fake/replies {content, match?}`,
   * where `match` keeps the reply for the first request whose user message contains it (so journeys
   * running side by side can't take each other's replies); requests without a match take unmatched steps.
   * With `hold` there too, the request waits for `POST /_fake/release {hold}` before it's answered (a journey looking at
   * something mid-run).
   */
  reply(content: string, during?: () => Promise<unknown>, match?: string): void;
  /**
   * Every request whose user message contains `match` that no step takes gets this reply, until `done()`: a reply a test
   * doesn't care about, never counted as unused (e.g. Autopilot's check accepting each edit).
   */
  otherwise(content: string, match: string): void;
  /** The next request (in order with replies; `match` as there) gets these tool calls instead of a reply. */
  toolCalls(calls: FakeToolCall[], match?: string): void;
  /** The next request fails with this HTTP status. */
  fail(status: number): void;
  /**
   * Every image request, in order. Each is answered, unscripted, with a real PNG in its aspect ratio and resolution
   * (1K about 1024² pixels: 1024×1024 at 1:1, 1365×768 at 16:9; 2K and 4K twice and four times as wide and tall), costing FAKE_IMAGE_COST.
   */
  images: ImageRequest[];
  /** Every decision request, in order (also `GET /_fake/decisions`). */
  decisions: DecisionRequest[];
  /**
   * The next decision request gets these answers (in order, like replies); `match` keeps them for the
   * first request whose state (as JSON) contains it. Also `POST /_fake/decisions {answers, match?}`.
   * A question the answers leave out is an error, like a step nobody scripted. `during` runs while the request waits
   * for them, e.g. a slow answer (the answer is still sent after it, if the request is still there).
   */
  decide(answers: FakeDecision, match?: string, during?: () => Promise<unknown>): void;
  /** Every decision request whose state contains `match` that no scripted answers take gets these, until `done()`; never counted as unused. */
  otherwiseDecide(answers: FakeDecision, match: string): void;
  /** Throws if a step wasn't used or a request came with no step left. */
  done(): void;
  close(): Promise<void>;
};

/**
 * A local stand-in for an OpenAI-compatible API (OpenRouter): chat completions, decisions and the models
 * list, and embeddings from an OpenAI fake (`embeddings`, its own unless one is given).
 * Tests script its replies; a request with nothing scripted fails (500) and
 * makes `done()` throw, like a step nobody used.
 */
export async function startModelFake({ embeddings: given }: { embeddings?: OpenAIFake } = {}): Promise<ModelFake> {
  const embeddings = given ?? (await startOpenAIFake());
  const steps: Step[] = [];
  const standing: Step[] = [];
  // Replies held till a journey releases them (POST /_fake/release), by name; released first, they don't wait.
  const holds = new Map<string, { promise: Promise<void>; release: () => void }>();
  const held = (name: string) => {
    let hold = holds.get(name);
    if (!hold) {
      let release = () => {};
      const promise = new Promise<void>((resolve) => (release = resolve));
      hold = { promise, release };
      holds.set(name, hold);
    }
    return hold;
  };
  const requests: ModelRequest[] = [];
  const images: ImageRequest[] = [];
  const decisionSteps: { answers: FakeDecision; match?: string; during?: () => Promise<unknown> }[] = [];
  const decisions: DecisionRequest[] = [];
  const standingDecisions: { answers: FakeDecision; match: string }[] = [];
  const unexpected: string[] = [];

  const server = createServer((req, res) => {
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { "Content-Type": "application/json" }).end(JSON.stringify(body));
    };
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", async () => {
      if (req.headers.authorization !== `Bearer ${FAKE_MODEL_KEY}`) {
        return send(401, { error: { message: "bad API key" } });
      }
      // Embeddings, and their vectors set over HTTP, are the OpenAI fake's.
      if (req.url === "/embeddings" || req.url === "/fixtures") {
        const response = await fetch(`${embeddings.url}${req.url}`, {
          method: req.method,
          headers: { authorization: `Bearer ${FAKE_OPENAI_KEY}`, "content-type": "application/json" },
          body: raw,
        });
        res.writeHead(response.status, { "Content-Type": "application/json" }).end(await response.text());
        return;
      }
      // Lets tests in another process (E2E journeys) check what the app asked.
      if (req.method === "GET" && req.url === "/models") {
        return send(200, { data: FAKE_MODELS });
      }
      if (req.method === "GET" && req.url === "/_fake/requests") {
        return send(200, requests);
      }
      if (req.method === "GET" && req.url === "/_fake/decisions") {
        return send(200, decisions);
      }
      let body: {
        model?: unknown;
        max_tokens?: unknown;
        messages?: ModelMessage[];
        tools?: unknown;
        temperature?: unknown;
        reasoning?: unknown;
        tool_choice?: unknown;
        content?: unknown;
        match?: unknown;
        hold?: unknown;
        modalities?: unknown;
        image_config?: { aspect_ratio?: unknown; image_size?: unknown };
        provider?: unknown;
        usage?: unknown;
      };
      try {
        body = JSON.parse(raw) as typeof body;
      } catch {
        return send(400, { error: { message: "expected JSON" } });
      }
      // Lets tests in another process (E2E journeys) script replies.
      if (req.method === "POST" && req.url === "/_fake/replies") {
        if (typeof body.content !== "string" || (body.match !== undefined && typeof body.match !== "string") || (body.hold !== undefined && typeof body.hold !== "string")) {
          return send(400, { error: { message: "expected {content, match?, hold?}" } });
        }
        const hold = body.hold as string | undefined;
        steps.push({ status: 200, content: body.content, match: body.match, during: hold === undefined ? undefined : () => held(hold).promise });
        return send(204, null);
      }
      if (req.method === "POST" && req.url === "/_fake/release") {
        if (typeof body.hold !== "string") {
          return send(400, { error: { message: "expected {hold}" } });
        }
        held(body.hold).release();
        return send(204, null);
      }
      if (req.method === "POST" && req.url === "/_fake/decisions") {
        const { answers, match } = body as { answers?: FakeDecision; match?: unknown };
        if (typeof answers !== "object" || answers === null || (match !== undefined && typeof match !== "string")) {
          return send(400, { error: { message: "expected {answers, match?}" } });
        }
        decisionSteps.push({ answers, match });
        return send(204, null);
      }
      // OpenRouter's Decisions API, at /api/alpha/decisions beside /api/v1 (here the base URL is the root).
      if (req.method === "POST" && req.url === "/alpha/decisions") {
        const request = body as unknown as DecisionRequest;
        if (typeof request.model !== "string" || request.state === undefined || typeof request.questions !== "object" || request.questions === null) {
          unexpected.push(`a decision request without a model, state and questions: ${raw.slice(0, 200)}`);
          return send(400, { error: { message: "expected a model, state and questions" } });
        }
        decisions.push(request);
        const state = JSON.stringify(request.state);
        let index = decisionSteps.findIndex((step) => step.match !== undefined && state.includes(step.match));
        if (index === -1) {
          index = decisionSteps.findIndex((step) => step.match === undefined);
        }
        const step = index === -1 ? standingDecisions.find((standing) => state.includes(standing.match)) : decisionSteps.splice(index, 1)[0];
        if (!step) {
          unexpected.push(`a decision request with no answers scripted: ${state.slice(0, 200)}`);
          return send(500, { error: { message: "the model fake has no decision scripted" } });
        }
        if ("during" in step) {
          await step.during?.();
        }
        const answers: Record<string, unknown> = {};
        for (const [name, question] of Object.entries(request.questions)) {
          const answer = step.answers[name] ?? step.answers["*"];
          if (answer === undefined) {
            unexpected.push(`a decision question with no answer scripted: ${name}`);
            return send(500, { error: { message: `no answer scripted for ${name}` } });
          }
          if (question.type === "noul" && typeof answer === "number") {
            answers[name] = { type: "noul", noul: answer };
          } else if (question.type === "choice" && typeof answer === "object") {
            const choice = Object.entries(answer).sort((a, b) => b[1] - a[1])[0]![0];
            answers[name] = { type: "choice", choice, probabilities: answer, confidence: answer[choice] };
          } else {
            unexpected.push(`a ${question.type} question answered with ${JSON.stringify(answer)}: ${name}`);
            return send(500, { error: { message: `wrong answer type scripted for ${name}` } });
          }
        }
        // Usage like OpenRouter's: a token per character of the state, one per answer, a hundred-millionth of a dollar each.
        const used = { input_tokens: state.length, output_tokens: Object.keys(answers).length };
        return send(200, {
          id: `gen-dec-fake-${decisions.length}`,
          // Like OpenRouter's: the build that answered, under the name asked for.
          model: `${request.model}-fake-build`,
          provider: "Fake",
          answers,
          usage: { ...used, cost: (used.input_tokens + used.output_tokens) / 1e8 },
        });
      }
      if (req.method !== "POST" || req.url !== "/chat/completions") {
        unexpected.push(`${req.method} ${req.url}`);
        return send(404, { error: { message: `unexpected ${req.method} ${req.url}` } });
      }
      if (Array.isArray(body.modalities) && body.modalities.includes("image")) {
        const parts = (body.messages?.[0]?.content ?? []) as { type?: string; text?: string; image_url?: { url?: string } }[];
        const prompt = Array.isArray(parts) ? parts.find((part) => part.type === "text")?.text : undefined;
        const [ratio, size] = [body.image_config?.aspect_ratio, body.image_config?.image_size];
        const scale = { "1K": 1, "2K": 2, "4K": 4 }[String(size)];
        const [w, h] = String(ratio).split(":").map(Number);
        if (typeof body.model !== "string" || typeof prompt !== "string" || !scale || !w || !h) {
          unexpected.push(`an image request without a model, a prompt, or a known aspect ratio and size: ${raw.slice(0, 200)}`);
          return send(400, { error: { message: "expected a model, a prompt and image_config" } });
        }
        images.push({
          model: body.model,
          prompt,
          references: parts.filter((part) => part.type === "image_url").map((part) => part.image_url?.url ?? ""),
          aspectRatio: ratio,
          imageSize: size,
          provider: body.provider,
          usage: body.usage,
        });
        const side = 1024 * scale;
        const png = solidPng(Math.round(side * Math.sqrt(w / h)), Math.round(side / Math.sqrt(w / h)));
        return send(200, {
          id: `fake-image-${images.length}`,
          object: "chat.completion",
          model: body.model,
          choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: "", images: [{ type: "image_url", image_url: { url: `data:image/png;base64,${png.toString("base64")}` } }] } }],
          usage: { prompt_tokens: prompt.length, completion_tokens: 1290, cost: FAKE_IMAGE_COST[String(size)], is_byok: false },
        });
      }
      const message = (role: string) => body.messages?.find((m) => m.role === role)?.content;
      const [system, user] = [message("system"), message("user")];
      if (typeof body.model !== "string" || typeof system !== "string" || typeof user !== "string") {
        unexpected.push(`a request without a model, a system and a user message: ${raw.slice(0, 200)}`);
        return send(400, { error: { message: "expected a model, a system and a user message" } });
      }
      // Like Anthropic's API (and OpenRouter's rule): a conversation that holds tool calls or their answers declares the tools.
      if (body.messages!.some((m) => m.tool_calls || m.role === "tool") && !(Array.isArray(body.tools) && body.tools.length > 0)) {
        unexpected.push("a request with tool calls in its messages but no tools declared");
        return send(400, { error: { message: "Requests which include tool_use or tool_result blocks must define tools" } });
      }
      requests.push({
        model: body.model,
        system,
        user,
        ...(typeof body.max_tokens === "number" && { maxTokens: body.max_tokens }),
        messages: body.messages!,
        ...(Array.isArray(body.tools) && { tools: body.tools }),
        ...(typeof body.temperature === "number" && { temperature: body.temperature }),
        ...(body.reasoning !== undefined && { reasoning: body.reasoning }),
        ...(body.tool_choice !== undefined && { toolChoice: body.tool_choice }),
      });
      let index = steps.findIndex((step) => step.match !== undefined && user.includes(step.match));
      if (index === -1) {
        index = steps.findIndex((step) => step.match === undefined);
      }
      const [step] = index === -1 ? standing.filter((one) => user.includes(one.match!)) : steps.splice(index, 1);
      if (!step) {
        unexpected.push(`a request with no reply scripted: ${user.slice(0, 200)}`);
        return send(500, { error: { message: "the model fake has no reply scripted" } });
      }
      await step.during?.();
      if (step.status !== 200) {
        return send(step.status, { error: { message: "fake failure" } });
      }
      // Usage like OpenRouter's: a token per character, a millionth of a dollar each. Anthropic's models
      // answer through our own key (BYOK), like production: OpenRouter charges nothing, the provider the rest.
      const toolCalls = step.toolCalls?.map((call, i) => ({ id: call.id ?? `call_${requests.length}_${i}`, type: "function", function: { name: call.name, arguments: call.arguments } }));
      const [prompt, completion] = [system.length + user.length, step.content?.length ?? JSON.stringify(toolCalls ?? "").length];
      const price = (prompt + completion) / 1e6;
      const byok = String(body.model).startsWith("anthropic/");
      send(200, {
        id: `fake-${requests.length}`,
        object: "chat.completion",
        model: body.model,
        choices: [
          toolCalls
            ? { index: 0, finish_reason: "tool_calls", message: { role: "assistant", content: null, tool_calls: toolCalls } }
            : { index: 0, finish_reason: "stop", message: { role: "assistant", content: step.content } },
        ],
        usage: { prompt_tokens: prompt, completion_tokens: completion, cost: byok ? 0 : price, is_byok: byok, cost_details: { upstream_inference_cost: price } },
      });
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  const url = `http://127.0.0.1:${port}`;

  return {
    url,
    // An OpenRouter key (sk-or-…), so the app counts on its Decisions API, as through a proxy in front of OpenRouter.
    env: { OPENAI_API_KEY: FAKE_MODEL_KEY, OPENAI_BASE_URL: url },
    embeddings,
    requests,
    images,
    reply(content, during, match) {
      steps.push({ status: 200, content, during, match });
    },
    otherwise(content, match) {
      standing.push({ status: 200, content, match });
    },
    toolCalls(calls, match) {
      steps.push({ status: 200, toolCalls: calls, match });
    },
    fail(status) {
      steps.push({ status });
    },
    decisions,
    decide(answers, match, during) {
      decisionSteps.push({ answers, match, during });
    },
    otherwiseDecide(answers, match) {
      standingDecisions.push({ answers, match });
    },
    done() {
      standing.splice(0);
      standingDecisions.splice(0);
      const problems = [
        ...unexpected.splice(0),
        ...steps
          .splice(0)
          .map((step) => `an unused step: ${step.content ?? (step.toolCalls ? `tool calls ${step.toolCalls.map((call) => call.name).join(", ")}` : `status ${step.status}`)}`),
        ...decisionSteps.splice(0).map((step) => `an unused decision: ${JSON.stringify(step.answers)}`),
      ];
      if (problems.length > 0) {
        throw new Error(`The model fake got:\n${problems.join("\n")}`);
      }
    },
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      if (!given) {
        await embeddings.close();
      }
    },
  };
}

/** A real PNG of one colour, `width` × `height` (RGB, 8 bits). */
function solidPng(width: number, height: number): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([length, body, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 2, 0, 0, 0], 8);
  // Each row: filter 0, then its pixels.
  const row = Buffer.alloc(1 + width * 3);
  for (let x = 0; x < width; x++) {
    row.set([90, 120, 200], 1 + x * 3);
  }
  const pixels = Buffer.concat(Array.from({ length: height }, () => row));
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", header), chunk("IDAT", deflateSync(pixels)), chunk("IEND", Buffer.alloc(0))]);
}
