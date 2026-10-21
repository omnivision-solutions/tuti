import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

export const FAKE_CLOUDFLARE_TOKEN = "cf-test-token";
export const FAKE_CLOUDFLARE_ZONE = "test-zone";

type Hostname = { id: string; hostname: string; status: string; ssl: { status: string } };

export type CloudflareFake = {
  /** CLOUDFLARE_API_URL, CLOUDFLARE_API_TOKEN and CLOUDFLARE_ZONE_ID for an app that uses this fake. */
  env: Record<string, string>;
  /** The zone's custom hostnames. */
  hostnames(): Hostname[];
  /** Cloudflare got the certificate for `hostname` (its CNAME points at us), or gave up. Also `POST /_fake/certificate {hostname, status}`. */
  certificate(hostname: string, status: "active" | "validation_timed_out"): void;
  /** The next API call waits for `during` before it's answered, e.g. a change racing it. */
  during(fn: () => Promise<unknown>): void;
  /** The next API call answers with this HTTP status (and a Cloudflare error). */
  failNext(status: number): void;
  close(): Promise<void>;
};

/**
 * A local stand-in for Cloudflare's custom hostnames API (Cloudflare for SaaS), one zone: create
 * (a duplicate is error 1406, like Cloudflare), list by hostname, get and delete. New hostnames
 * wait for their certificate until a test says Cloudflare got it.
 */
export async function startCloudflareFake(): Promise<CloudflareFake> {
  const hostnames = new Map<string, Hostname>();
  let failure: number | undefined;
  let next: (() => Promise<unknown>) | undefined;
  const certificate = (hostname: string, status: string) => {
    for (const entry of hostnames.values()) {
      if (entry.hostname === hostname) {
        entry.ssl.status = status;
        entry.status = status === "active" ? "active" : "pending";
      }
    }
  };

  const server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) {
      body += chunk;
    }
    const answer = (status: number, result: unknown, errors: { code: number; message: string }[] = []) => {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify({ success: status < 300, errors, messages: [], result }));
    };
    const url = new URL(request.url!, "http://localhost");
    if (request.method === "POST" && url.pathname === "/_fake/certificate") {
      const { hostname, status } = JSON.parse(body) as { hostname: string; status: string };
      certificate(hostname, status);
      return answer(200, {});
    }
    if (request.headers.authorization !== `Bearer ${FAKE_CLOUDFLARE_TOKEN}`) {
      return answer(403, null, [{ code: 10000, message: "Authentication error" }]);
    }
    if (next) {
      const fn = next;
      next = undefined;
      await fn();
    }
    if (failure) {
      const status = failure;
      failure = undefined;
      return answer(status, null, [{ code: 1000, message: "Something went wrong" }]);
    }
    const base = `/zones/${FAKE_CLOUDFLARE_ZONE}/custom_hostnames`;
    if (url.pathname === base && request.method === "POST") {
      const { hostname } = JSON.parse(body) as { hostname: string };
      if ([...hostnames.values()].some((entry) => entry.hostname === hostname)) {
        return answer(409, null, [{ code: 1406, message: "Duplicate custom hostname found." }]);
      }
      const entry = { id: randomUUID(), hostname, status: "pending", ssl: { status: "pending_validation" } };
      hostnames.set(entry.id, entry);
      return answer(201, entry);
    }
    if (url.pathname === base && request.method === "GET") {
      const hostname = url.searchParams.get("hostname");
      return answer(200, [...hostnames.values()].filter((entry) => !hostname || entry.hostname === hostname));
    }
    const id = url.pathname.startsWith(`${base}/`) ? decodeURIComponent(url.pathname.slice(base.length + 1)) : undefined;
    const entry = id && hostnames.get(id);
    if (!entry) {
      return answer(404, null, [{ code: 1436, message: "The custom hostname was not found." }]);
    }
    if (request.method === "GET") {
      return answer(200, entry);
    }
    if (request.method === "DELETE") {
      hostnames.delete(entry.id);
      return answer(200, { id: entry.id });
    }
    answer(405, null, [{ code: 10405, message: "Method not allowed" }]);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  const url = `http://127.0.0.1:${port}`;

  return {
    env: { CLOUDFLARE_API_URL: url, CLOUDFLARE_API_TOKEN: FAKE_CLOUDFLARE_TOKEN, CLOUDFLARE_ZONE_ID: FAKE_CLOUDFLARE_ZONE },
    hostnames: () => [...hostnames.values()],
    certificate,
    during: (fn) => {
      next = fn;
    },
    failNext: (status) => {
      failure = status;
    },
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}
