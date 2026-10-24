import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

export const FAKE_MODEL_KEY = "sk-or-test-fake";

/** What a request asked: its model, messages and token cap. */
export type ModelRequest = { model: string; system: string; user: string; maxTokens?: number };

/** What a decision request asked: its model, state and questions (OpenRouter's Decisions API). */
export type DecisionRequest = { model: string; state: unknown; questions: Record<string, { type: string; instructions: unknown; criteria?: unknown }>; provider?: unknown };

/**
 * A scripted decision, per question name: a number answers a yes/no ("noul") question with that
 * probability; an object of probabilities answers a choice question (its choice is the likeliest).
 */
export type FakeDecision = Record<string, number | Record<string, number>>;

/** A scripted answer: a reply (status 200) or an error status. */
type Step = { status: number; content?: string; during?: () => Promise<unknown>; match?: string };

export type ModelFake = {
  /** Base URL to use as OPENROUTER_BASE_URL. */
  url: string;
  /** OPENROUTER_API_KEY and OPENROUTER_BASE_URL for an app that uses this fake. */
  env: Record<string, string>;
  /** Every chat completion request, in order (also `GET /_fake/requests`). */
  requests: ModelRequest[];
  /**
   * The next request gets this reply (steps are used in order). `during` runs while
   * that request waits for it, e.g. a save racing the model. Also `POST /_fake/replies {content, match?}`,
   * where `match` keeps the reply for the first request whose user message contains it (so journeys
   * running side by side can't take each other's replies); requests without a match take unmatched steps.
   */
  reply(content: string, during?: () => Promise<unknown>, match?: string): void;
  /** The next request fails with this HTTP status. */
  fail(status: number): void;
  /** Every decision request, in order (also `GET /_fake/decisions`). */
  decisions: DecisionRequest[];
  /**
   * The next decision request gets these answers (in order, like replies); `match` keeps them for the
   * first request whose state (as JSON) contains it. Also `POST /_fake/decisions {answers, match?}`.
   * A question the answers leave out is an error, like a step nobody scripted.
   */
  decide(answers: FakeDecision, match?: string): void;
  /** Throws if a step wasn't used or a request came with no step left. */
  done(): void;
  close(): Promise<void>;
};

/**
 * A local stand-in for an OpenAI-compatible chat completions API (OpenRouter).
 * Tests script its replies; a request with nothing scripted fails (500) and
 * makes `done()` throw, like a step nobody used.
 */
export async function startModelFake(): Promise<ModelFake> {
  const steps: Step[] = [];
  const requests: ModelRequest[] = [];
  const decisionSteps: { answers: FakeDecision; match?: string }[] = [];
  const decisions: DecisionRequest[] = [];
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
      // Lets tests in another process (E2E journeys) check what the app asked.
      if (req.method === "GET" && req.url === "/_fake/requests") {
        return send(200, requests);
      }
      if (req.method === "GET" && req.url === "/_fake/decisions") {
        return send(200, decisions);
      }
      let body: { model?: unknown; max_tokens?: unknown; messages?: { role?: unknown; content?: unknown }[]; content?: unknown; match?: unknown };
      try {
        body = JSON.parse(raw) as typeof body;
      } catch {
        return send(400, { error: { message: "expected JSON" } });
      }
      // Lets tests in another process (E2E journeys) script replies.
      if (req.method === "POST" && req.url === "/_fake/replies") {
        if (typeof body.content !== "string" || (body.match !== undefined && typeof body.match !== "string")) {
          return send(400, { error: { message: "expected {content, match?}" } });
        }
        steps.push({ status: 200, content: body.content, match: body.match });
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
        const [step] = index === -1 ? [] : decisionSteps.splice(index, 1);
        if (!step) {
          unexpected.push(`a decision request with no answers scripted: ${state.slice(0, 200)}`);
          return send(500, { error: { message: "the model fake has no decision scripted" } });
        }
        const answers: Record<string, unknown> = {};
        for (const [name, question] of Object.entries(request.questions)) {
          const answer = step.answers[name];
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
      const message = (role: string) => body.messages?.find((m) => m.role === role)?.content;
      const [system, user] = [message("system"), message("user")];
      if (typeof body.model !== "string" || typeof system !== "string" || typeof user !== "string") {
        unexpected.push(`a request without a model, a system and a user message: ${raw.slice(0, 200)}`);
        return send(400, { error: { message: "expected a model, a system and a user message" } });
      }
      requests.push({ model: body.model, system, user, ...(typeof body.max_tokens === "number" && { maxTokens: body.max_tokens }) });
      let index = steps.findIndex((step) => step.match !== undefined && user.includes(step.match));
      if (index === -1) {
        index = steps.findIndex((step) => step.match === undefined);
      }
      const [step] = index === -1 ? [] : steps.splice(index, 1);
      if (!step) {
        unexpected.push(`a request with no reply scripted: ${user.slice(0, 200)}`);
        return send(500, { error: { message: "the model fake has no reply scripted" } });
      }
      await step.during?.();
      if (step.status !== 200) {
        return send(step.status, { error: { message: "fake failure" } });
      }
      // Usage like OpenRouter's: a token per character, a millionth of a dollar each.
      const [prompt, completion] = [system.length + user.length, step.content?.length ?? 0];
      send(200, {
        id: `fake-${requests.length}`,
        object: "chat.completion",
        model: body.model,
        choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: step.content } }],
        usage: { prompt_tokens: prompt, completion_tokens: completion, cost: (prompt + completion) / 1e6 },
      });
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  const url = `http://127.0.0.1:${port}`;

  return {
    url,
    env: { OPENROUTER_API_KEY: FAKE_MODEL_KEY, OPENROUTER_BASE_URL: url },
    requests,
    reply(content, during, match) {
      steps.push({ status: 200, content, during, match });
    },
    fail(status) {
      steps.push({ status });
    },
    decisions,
    decide(answers, match) {
      decisionSteps.push({ answers, match });
    },
    done() {
      const problems = [
        ...unexpected.splice(0),
        ...steps.splice(0).map((step) => `an unused step: ${step.content ?? `status ${step.status}`}`),
        ...decisionSteps.splice(0).map((step) => `an unused decision: ${JSON.stringify(step.answers)}`),
      ];
      if (problems.length > 0) {
        throw new Error(`The model fake got:\n${problems.join("\n")}`);
      }
    },
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}
