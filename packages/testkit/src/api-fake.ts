import { createServer, type IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";

export type ApiFakeRequest = { method: string; path: string; query: string; headers: IncomingHttpHeaders; body: string };

export type ApiFake = {
  /** e.g. http://127.0.0.1:4321 */
  origin: string;
  /** What it was sent, oldest first. */
  requests: ApiFakeRequest[];
  close(): Promise<void>;
};

/** The most `/large` sends: enough to pass Try it's 2 MB cut. */
const LARGEST = 3_000_000;

/**
 * A local stand-in for a team's API, for Try it: answers every request with JSON of what it got (201, its method,
 * path, query and body), except `/redirect` (a 302 to another site), `/large` (`size` bytes of text, up to LARGEST)
 * and `/stall` (never answers). With `cors` it lets browsers on any site call it, the key's header too; without, a
 * browser's request to it fails.
 */
export async function startApiFake({ cors }: { cors: boolean }): Promise<ApiFake> {
  const requests: ApiFakeRequest[] = [];
  const allow = cors
    ? // "*" doesn't cover Authorization: browsers want it named.
      { "access-control-allow-origin": "*", "access-control-allow-headers": "*, Authorization", "access-control-allow-methods": "*", "access-control-expose-headers": "*" }
    : {};
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) {
      body += chunk;
    }
    const url = new URL(request.url!, "http://localhost");
    if (request.method === "OPTIONS") {
      response.writeHead(cors ? 204 : 404, allow).end();
      return;
    }
    requests.push({ method: request.method!, path: url.pathname, query: url.search, headers: request.headers, body });
    if (url.pathname.endsWith("/redirect")) {
      response.writeHead(302, { ...allow, location: "https://elsewhere.example/" }).end();
      return;
    }
    if (url.pathname.endsWith("/stall")) {
      return;
    }
    if (url.pathname.endsWith("/large")) {
      const size = Number(url.searchParams.get("size") ?? 0);
      if (!(size >= 0 && size <= LARGEST)) {
        response.writeHead(400, allow).end();
        return;
      }
      response.writeHead(200, { ...allow, "content-type": "text/plain" }).end("x".repeat(size));
      return;
    }
    response
      .writeHead(201, { ...allow, "content-type": "application/json", "x-request-id": "fake-1" })
      .end(JSON.stringify({ method: request.method, path: url.pathname, query: url.search, body }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    origin: `http://127.0.0.1:${port}`,
    requests,
    close: () =>
      new Promise((resolve) => {
        server.close(() => resolve());
        // A stalled request's connection too.
        server.closeAllConnections();
      }),
  };
}
