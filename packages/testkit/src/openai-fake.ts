import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

export const FAKE_OPENAI_KEY = "sk-test-fake";
const DIMENSIONS = 1536;
/** Dimensions reserved for hand-written vectors; texts without one get a one-hot vector above these. */
const FIXTURE_DIMENSIONS = 64;

export type OpenAIFake = {
  /** Base URL to use as OPENAI_BASE_URL. */
  url: string;
  /** Texts sent to the embeddings endpoint, in order. */
  inputs: string[];
  /** The model of each request, in order. */
  models: string[];
  /** Give a text a specific vector (up to 64 numbers, padded with zeros); also `POST /fixtures {text, vector}`. */
  setVector(text: string, vector: number[]): void;
  /** Make the next request fail with this HTTP status. */
  failNext(status?: number): void;
  /** Hold the answer to the next embeddings request until the returned function is called (its texts are in `inputs` already). */
  holdNext(): () => void;
  close(): Promise<void>;
};

/**
 * A local stand-in for OpenAI's embeddings API. Tests decide how similar texts
 * are: texts given the same or nearby vectors are similar; any other text gets
 * its own unit vector, unrelated to every fixture (cosine similarity 0).
 */
export async function startOpenAIFake(): Promise<OpenAIFake> {
  const vectors = new Map<string, number[]>();
  const inputs: string[] = [];
  const models: string[] = [];
  let failStatus: number | undefined;
  let hold: Promise<void> | undefined;

  const server = createServer((req, res) => {
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { "Content-Type": "application/json" }).end(JSON.stringify(body));
    };
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      if (req.headers.authorization !== `Bearer ${FAKE_OPENAI_KEY}`) {
        return send(401, { error: { message: "bad API key" } });
      }
      // Lets tests in another process (E2E journeys) give texts their vectors.
      if (req.method === "POST" && req.url === "/fixtures") {
        let fixture: { text?: unknown; vector?: unknown };
        try {
          fixture = JSON.parse(raw) as typeof fixture;
        } catch {
          return send(400, { error: { message: "expected JSON" } });
        }
        const { text, vector } = fixture;
        if (
          typeof text !== "string" ||
          !Array.isArray(vector) ||
          vector.length > FIXTURE_DIMENSIONS ||
          !vector.every((n) => typeof n === "number" && Number.isFinite(n))
        ) {
          return send(400, { error: { message: `expected {text, vector} with at most ${FIXTURE_DIMENSIONS} numbers` } });
        }
        setVector(text, vector);
        return send(204, null);
      }
      if (req.method !== "POST" || req.url !== "/embeddings") {
        return send(404, { error: { message: `unexpected ${req.method} ${req.url}` } });
      }
      if (failStatus) {
        const status = failStatus;
        failStatus = undefined;
        return send(status, { error: { message: "fake failure" } });
      }
      const body = JSON.parse(raw) as { model?: string; input?: string[] };
      if (typeof body.model !== "string" || !Array.isArray(body.input)) {
        return send(400, { error: { message: "expected model and an input array" } });
      }
      models.push(body.model);
      inputs.push(...body.input);
      // Reverse order on purpose: callers must sort by index.
      const data = body.input.map((text, index) => ({ index, embedding: vectorFor(text) })).reverse();
      const held = hold;
      hold = undefined;
      void (held ?? Promise.resolve()).then(() => send(200, { data }));
    });
  });

  function setVector(text: string, vector: number[]) {
    if (vector.length > FIXTURE_DIMENSIONS) throw new Error(`at most ${FIXTURE_DIMENSIONS} numbers`);
    vectors.set(text, vector);
  }

    function vectorFor(text: string): number[] {
    const vector = new Array<number>(DIMENSIONS).fill(0);
    const fixture = vectors.get(text);
    if (fixture) {
      fixture.forEach((value, i) => (vector[i] = value));
    } else {
      let hash = 0;
      for (const char of text) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
      vector[FIXTURE_DIMENSIONS + (hash % (DIMENSIONS - FIXTURE_DIMENSIONS))] = 1;
    }
    return vector;
  }

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}`,
    inputs,
    models,
    setVector,
    failNext(status = 500) {
      failStatus = status;
    },
    holdNext() {
      let release = () => {};
      hold = new Promise((resolve) => (release = resolve));
      return release;
    },
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}
