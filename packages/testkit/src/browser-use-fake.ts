import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { crc32, deflateSync } from "node:zlib";

/** The key the fake accepts (X-Browser-Use-API-Key). */
export const FAKE_BROWSER_USE_KEY = "bu_fake_key";

/**
 * How the fake's next run goes (JSON, so journeys in other processes can script it through /_fake/next-run). By
 * default the agent signs in and reaches every screenshot the task names (`shot-N.png: …` lines), saving a PNG each.
 */
export type FakeBrowserUseRun = {
  /** The run's end: completed by default. */
  status?: "completed" | "failed";
  /** A failed run's error. */
  error?: string;
  /** The agent couldn't sign in, saying this. */
  signInFailed?: string;
  /** Screenshots it couldn't reach, by file, with why. */
  unreached?: Record<string, string>;
  /** Its whole answer instead (output), e.g. text it can't be read from. */
  output?: unknown;
  /** The session's cost; the default is { llm 0.0308, browser 0.005, proxy 0.0061, total 0.0419 }. */
  cost?: { llmCostUsd?: string; searchCostUsd?: string; browserCostUsd?: string; proxyCostUsd?: string; totalCostUsd?: string };
  /** Its session's cost can't be read (`/sessions/{id}/cost` answers this status). */
  costStatus?: number;
  /** It keeps running (`/status` answers running) until `release()`: an agent that takes a while. */
  stuck?: boolean;
  /** Creating the run fails with this status (e.g. 402). */
  createStatus?: number;
};

export type BrowserUseFake = {
  /** For BROWSER_USE_API_URL and BROWSER_USE_API_KEY. */
  env: { BROWSER_USE_API_URL: string; BROWSER_USE_API_KEY: string };
  url: string;
  /** Scripts the next runs, in order; one not scripted goes by the defaults. */
  next(...runs: FakeBrowserUseRun[]): void;
  /** Every run created: its request body (with the secrets as sent) and session. */
  runs: { body: Record<string, unknown> & { task: string; model: string }; sessionId: string; workspaceId: string }[];
  /** Browsers by session, and whether they're stopped. */
  browsers: Map<string, { id: string; status: "active" | "stopped" }>;
  /** What was done to sessions and workspaces, in order: `stop <session>`, `delete <workspace>`, `cost <session>`. */
  events: string[];
  /** Files left in each workspace, by path (the agent's, until they're deleted). */
  files: Map<string, Map<string, Uint8Array>>;
  /** Sessions whose cost was read. */
  costsRead: string[];
  /** How many of the next requests of each kind fail (500): deleting a file, reading a session's cost, stopping a browser. */
  failNext: { deletes: number; costs: number; stops: number };
  /** Lets every stuck run end. */
  release(): void;
  close(): Promise<void>;
};

/** A solid-colour PNG, `width` × `height`: a screenshot as the agent saves one. */
export function fakePng(width = 144, height = 90, rgb: [number, number, number] = [99, 102, 241]): Uint8Array {
  const chunk = (type: string, data: Buffer) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([length, body, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 2, 0, 0, 0], 8);
  const row = Buffer.concat([Buffer.from([0]), Buffer.from(Array.from({ length: width }, () => rgb).flat())]);
  const pixels = Buffer.concat(Array.from({ length: height }, () => row));
  return new Uint8Array(
    Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", header), chunk("IDAT", deflateSync(pixels)), chunk("IEND", Buffer.alloc(0))]),
  );
}

/**
 * A local stand-in for Browser Use Cloud's API v4 (https://api.browser-use.com/api/v4), as Screenshots uses it:
 * workspaces, runs (create, status, summary), workspace files with download links, browsers (list by session, stop)
 * and a session's cost. Runs end at once, as scripted (`next`), the agent's files saved in the workspace's outputs/.
 */
export async function startBrowserUseFake(): Promise<BrowserUseFake> {
  let ids = 0;
  const id = (kind: string) => `00000000-0000-4000-8000-${kind}${String(++ids).padStart(12 - kind.length, "0")}`;
  const scripts: FakeBrowserUseRun[] = [];
  const runs = new Map<string, { script: FakeBrowserUseRun; sessionId: string; workspaceId: string; task: string; model: string }>();
  const files = new Map<string, Map<string, Uint8Array>>();
  const downloads = new Map<string, Uint8Array>();
  const fake: BrowserUseFake = {
    env: { BROWSER_USE_API_URL: "", BROWSER_USE_API_KEY: FAKE_BROWSER_USE_KEY },
    url: "",
    next: (...more) => scripts.push(...more),
    runs: [],
    browsers: new Map(),
    costsRead: [],
    events: [],
    failNext: { deletes: 0, costs: 0, stops: 0 },
    files,
    release: () => {
      for (const run of runs.values()) {
        run.script.stuck = false;
      }
    },
    close: async () => {},
  };
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      const answer = (status: number, body: unknown) => res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
      const url = new URL(req.url ?? "/", "http://fake");
      const path = url.pathname.replace(/^\/api\/v4/, "");
      // Downloads are presigned: no key.
      const download = /^\/_download\/(.+)$/.exec(path);
      if (download) {
        const body = downloads.get(download[1]!);
        return body ? res.writeHead(200, { "content-type": "image/png" }).end(body) : answer(404, { detail: "Gone" });
      }
      if (path === "/_fake/next-run" && req.method === "POST") {
        fake.next(JSON.parse(raw) as FakeBrowserUseRun);
        return answer(200, {});
      }
      if (req.headers["x-browser-use-api-key"] !== FAKE_BROWSER_USE_KEY) {
        return answer(401, { detail: "Invalid API key" });
      }
      const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
      if (path === "/workspaces" && req.method === "POST") {
        const workspaceId = id("a");
        files.set(workspaceId, new Map());
        return answer(200, { id: workspaceId, name: body.name });
      }
      if (path === "/runs" && req.method === "POST") {
        // A copy: release() changes it.
        // Browser Use's residential proxy is on by default (billed per GB): Tuti always says whether it wants it, so a run
        // that leaves it out is refused.
        const settings = body.browserSettings as { proxyCountryCode?: unknown } | null | undefined;
        if (!settings || !("proxyCountryCode" in settings) || (settings.proxyCountryCode !== null && typeof settings.proxyCountryCode !== "string")) {
          return answer(422, { detail: "The fake refuses a run without browserSettings.proxyCountryCode (Browser Use's residential proxy is on by default)" });
        }
        const script = { ...(scripts.shift() ?? {}) };
        if (script.createStatus) {
          return answer(script.createStatus, { detail: "The fake was told to refuse this run" });
        }
        const runId = id("b");
        const sessionId = id("c");
        const workspaceId = String(body.workspaceId);
        runs.set(runId, { script, sessionId, workspaceId, task: String(body.task), model: String(body.model) });
        fake.runs.push({ body: body as BrowserUseFake["runs"][number]["body"], sessionId, workspaceId });
        // The run's browser, which outlives it until stopped.
        fake.browsers.set(sessionId, { id: id("d"), status: "active" });
        // The agent's work: each screenshot the task names saved, but those it couldn't reach (or any, signed out).
        if ((script.status ?? "completed") === "completed" && !script.signInFailed) {
          for (const [, file] of String(body.task).matchAll(/^(shot-\d+\.png): /gm)) {
            if (!script.unreached?.[file!]) {
              files.get(workspaceId)?.set(`outputs/${file}`, fakePng());
            }
          }
        }
        return answer(200, { id: runId, status: "queued", model: body.model, sessionId, workspaceId, eventsUrl: `${fake.url}/runs/${runId}/events` });
      }
      const status = /^\/runs\/([^/]+)\/status$/.exec(path);
      if (status && runs.has(status[1]!)) {
        const run = runs.get(status[1]!)!;
        return answer(200, { status: run.script.stuck ? "running" : (run.script.status ?? "completed") });
      }
      const summary = /^\/runs\/([^/]+)$/.exec(path);
      if (summary && runs.has(summary[1]!)) {
        const run = runs.get(summary[1]!)!;
        const files = [...run.task.matchAll(/^(shot-\d+\.png): (.*)$/gm)];
        const output =
          run.script.output !== undefined
            ? run.script.output
            : run.script.signInFailed
              ? { signedIn: false, error: run.script.signInFailed, shots: [] }
              : {
                  signedIn: true,
                  shots: files.map(([, file, show]) =>
                    run.script.unreached?.[file!]
                      ? { file, reached: false, reason: run.script.unreached[file!] }
                      : { file, reached: true, description: `The screen: ${show}`, url: "https://app.example.com/dashboard" },
                  ),
                };
        const failed = run.script.status === "failed";
        return answer(200, {
          id: summary[1],
          task: run.task,
          title: null,
          model: run.model,
          contextLimit: 100000,
          status: run.script.status ?? "completed",
          result: failed ? null : typeof output === "string" ? output : JSON.stringify(output),
          output: failed || typeof output === "string" ? null : output,
          error: failed ? (run.script.error ?? "The agent failed") : null,
          sessionId: run.sessionId,
          workspaceId: run.workspaceId,
          totalInputTokens: 12000,
          totalOutputTokens: 800,
          totalCostUsd: "0.030800",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        });
      }
      const listed = /^\/workspaces\/([^/]+)\/files$/.exec(path);
      if (listed && files.has(listed[1]!) && req.method === "DELETE") {
        if (fake.failNext.deletes > 0) {
          fake.failNext.deletes--;
          return answer(500, { detail: "The fake was told to fail this delete" });
        }
        fake.events.push(`delete ${listed[1]}`);
        const removed = files.get(listed[1]!)!.delete(url.searchParams.get("path") ?? "");
        return removed ? res.writeHead(204).end() : answer(404, { detail: "Not found" });
      }
      if (listed && files.has(listed[1]!)) {
        return answer(200, {
          // 100 at most, as Browser Use's `limit` caps a page.
          files: [...files.get(listed[1]!)!].slice(0, Math.min(100, Number(url.searchParams.get("limit") ?? 50))).map(([path, bytes]) => {
            const token = id("e");
            downloads.set(token, bytes);
            return { path, size: bytes.byteLength, lastModified: new Date().toISOString(), url: url.searchParams.get("includeUrls") === "true" ? `${fake.url}/_download/${token}` : null };
          }),
          nextCursor: null,
          hasMore: false,
        });
      }
      if (path === "/browsers" && req.method === "GET") {
        const session = url.searchParams.get("agentSessionId");
        const browser = session ? fake.browsers.get(session) : undefined;
        const items = browser && (!url.searchParams.get("filterBy") || url.searchParams.get("filterBy") === browser.status) ? [{ ...browser, agentSessionId: session }] : [];
        return answer(200, { items, totalItems: items.length, pageNumber: 1, pageSize: 100 });
      }
      const stop = /^\/browsers\/([^/]+)$/.exec(path);
      if (stop && req.method === "PATCH" && fake.failNext.stops > 0) {
        fake.failNext.stops--;
        return answer(500, { detail: "The fake was told to fail this stop" });
      }
      if (stop && req.method === "PATCH") {
        const browser = [...fake.browsers.values()].find((one) => one.id === stop[1]);
        if (!browser || body.action !== "stop") {
          return answer(404, { detail: "Session not found" });
        }
        browser.status = "stopped";
        fake.events.push(`stop ${[...fake.browsers].find(([, one]) => one === browser)![0]}`);
        return answer(200, { ...browser });
      }
      const cost = /^\/sessions\/([^/]+)\/cost$/.exec(path);
      if (cost && fake.browsers.has(cost[1]!)) {
        if (fake.failNext.costs > 0) {
          fake.failNext.costs--;
          return answer(500, { detail: "The fake was told to fail this cost read" });
        }
        fake.costsRead.push(cost[1]!);
        fake.events.push(`cost ${cost[1]}`);
        const run = [...runs.values()].find((one) => one.sessionId === cost[1]);
        if (run?.script.costStatus) {
          return answer(run.script.costStatus, { detail: "The fake was told not to say" });
        }
        const given = run?.script.cost ?? {};
        return answer(200, {
          llmCostUsd: given.llmCostUsd ?? "0.030800",
          searchCostUsd: given.searchCostUsd ?? "0.000000",
          browserCostUsd: given.browserCostUsd ?? "0.005000",
          proxyCostUsd: given.proxyCostUsd ?? "0.006100",
          proxyUsedMb: "12.400000",
          totalCostUsd: given.totalCostUsd ?? "0.041900",
        });
      }
      answer(404, { detail: `The fake has no ${req.method} ${path}` });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  fake.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  fake.env.BROWSER_USE_API_URL = `${fake.url}/api/v4`;
  fake.close = () => new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  return fake;
}
