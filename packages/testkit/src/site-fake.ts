import { createServer, request as forwardRequest } from "node:http";
import type { AddressInfo } from "node:net";

export type SiteFake = {
  /** The site's origin, e.g. http://127.0.0.1:4321. */
  origin: string;
  /** Answers `path` with `body` (200, text/plain); none: the site's own 404. Also `POST /_fake/answer {path, body}`. */
  answer(path: string, body: string | null): void;
  /**
   * Forwards everything under `path` to `target` (an origin), path, query, cookies and all, the way a
   * team's site forwards its /portal to Tuti (a Next.js rewrite, Nginx, …): the answer comes back as is.
   * Also `POST /_fake/forward {path, target}`.
   */
  forward(path: string, target: string): void;
  /** The next request waits for `during` before it's answered, e.g. a change racing a check. */
  during(fn: () => Promise<unknown>): void;
  close(): Promise<void>;
};

/** A local stand-in for a team's own website, with a path that goes to a Tuti portal (portals under a site's path). */
export async function startSiteFake(): Promise<SiteFake> {
  const answers = new Map<string, string>();
  const forwards = new Map<string, string>();
  const answer = (path: string, body: string | null) => (body === null ? answers.delete(path) : answers.set(path, body));
  const forward = (path: string, target: string) => forwards.set(path, target);
  let next: (() => Promise<unknown>) | undefined;

  const server = createServer(async (request, response) => {
    const url = new URL(request.url!, "http://localhost");
    if (request.method === "POST" && url.pathname.startsWith("/_fake/")) {
      let body = "";
      for await (const chunk of request) {
        body += chunk;
      }
      const input = JSON.parse(body) as { path: string; body?: string | null; target?: string };
      if (url.pathname === "/_fake/answer") {
        answer(input.path, input.body ?? null);
      } else {
        forward(input.path, input.target!);
      }
      response.writeHead(200).end();
      return;
    }
    if (next) {
      const fn = next;
      next = undefined;
      await fn();
    }
    const fixed = answers.get(url.pathname);
    if (fixed !== undefined) {
      response.writeHead(200, { "content-type": "text/plain" }).end(fixed);
      return;
    }
    const [path, target] = [...forwards].find(([path]) => url.pathname === path || url.pathname.startsWith(`${path}/`)) ?? [];
    if (!path || !target) {
      response.writeHead(404, { "content-type": "text/html" }).end("<h1>The site's own page</h1>");
      return;
    }
    // Like a proxy: the target's host, the site's host as X-Forwarded-Host.
    const to = new URL(request.url!, target);
    const upstream = forwardRequest(
      to,
      { method: request.method, headers: { ...request.headers, host: to.host, "x-forwarded-host": request.headers.host, "x-forwarded-proto": "http" } },
      (answer) => {
        response.writeHead(answer.statusCode ?? 502, answer.headers);
        answer.pipe(response);
      },
    );
    upstream.on("error", () => response.writeHead(502).end());
    request.pipe(upstream);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    origin: `http://127.0.0.1:${port}`,
    answer,
    forward,
    during: (fn) => {
      next = fn;
    },
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}
