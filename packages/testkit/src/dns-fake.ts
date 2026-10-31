import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

export type DnsFake = {
  /** Use as DNS_LOOKUP_URL. */
  url: string;
  /** Sets the TXT records at `name` (none: removes them). Also `POST /_fake/txt {name, values}`, from other processes. */
  txt(name: string, values: string[]): void;
  /** Sets the mail servers `name`'s MX records name (none: removes them). Also `POST /_fake/mx {name, hosts}`. */
  mx(name: string, hosts: string[]): void;
  /** The next lookup waits for `during` before it answers, e.g. a change racing the lookup. */
  during(fn: () => Promise<unknown>): void;
  /** Lookups fail (the resolver answers 503) until it's false again. */
  fail(failing: boolean): void;
  close(): Promise<void>;
};

/**
 * A local stand-in for a DNS-over-HTTPS resolver's JSON API (as Cloudflare's: `?name=&type=TXT`
 * with `accept: application/dns-json`). TXT records, quoted like Cloudflare quotes them, and MX
 * records; names it doesn't know answer NXDOMAIN.
 */
export async function startDnsFake(): Promise<DnsFake> {
  // By type and name ("TXT acme.com"): each answer's data as the resolver gives it.
  const records = new Map<string, string[]>();
  let failing = false;
  let next: (() => Promise<unknown>) | undefined;
  const set = (type: "TXT" | "MX", name: string, data: string[]) => {
    if (data.length > 0) {
      records.set(`${type} ${name.toLowerCase()}`, data);
    } else {
      records.delete(`${type} ${name.toLowerCase()}`);
    }
  };
  const txt = (name: string, values: string[]) => set("TXT", name, values.map((value) => `"${value.replace(/["\\]/g, "\\$&")}"`));
  const mx = (name: string, hosts: string[]) => set("MX", name, hosts.map((host, i) => `${(i + 1) * 10} ${host}.`));

  const server = createServer(async (request, response) => {
    const url = new URL(request.url!, "http://localhost");
    const json = (status: number, body: unknown) => {
      response.writeHead(status, { "content-type": "application/dns-json" });
      response.end(JSON.stringify(body));
    };
    if (request.method === "POST" && url.pathname === "/_fake/txt") {
      let body = "";
      for await (const chunk of request) {
        body += chunk;
      }
      const { name, values } = JSON.parse(body) as { name: string; values: string[] };
      txt(name, values);
      return json(200, {});
    }
    if (request.method === "POST" && url.pathname === "/_fake/mx") {
      let body = "";
      for await (const chunk of request) {
        body += chunk;
      }
      const { name, hosts } = JSON.parse(body) as { name: string; hosts: string[] };
      mx(name, hosts);
      return json(200, {});
    }
    if (next) {
      const fn = next;
      next = undefined;
      await fn();
    }
    if (failing) {
      return json(503, {});
    }
    const name = (url.searchParams.get("name") ?? "").toLowerCase().replace(/\.$/, "");
    const type = url.searchParams.get("type");
    if ((type !== "TXT" && type !== "MX") || request.headers.accept !== "application/dns-json") {
      return json(400, {});
    }
    const data = records.get(`${type} ${name}`);
    json(200, {
      Status: data ? 0 : 3,
      Answer: data?.map((value) => ({ name: `${name}.`, type: type === "TXT" ? 16 : 15, TTL: 300, data: value })),
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}/dns-query`,
    txt,
    mx,
    during: (fn) => {
      next = fn;
    },
    fail: (value) => {
      failing = value;
    },
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}
