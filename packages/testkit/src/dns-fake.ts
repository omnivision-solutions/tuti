import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

export type DnsFake = {
  /** Use as DNS_LOOKUP_URL. */
  url: string;
  /** Sets the TXT records at `name` (none: removes them). Also `POST /_fake/txt {name, values}`, from other processes. */
  txt(name: string, values: string[]): void;
  /** Lookups fail (the resolver answers 503) until it's false again. */
  fail(failing: boolean): void;
  close(): Promise<void>;
};

/**
 * A local stand-in for a DNS-over-HTTPS resolver's JSON API (as Cloudflare's: `?name=&type=TXT`
 * with `accept: application/dns-json`). Only TXT records, quoted like Cloudflare quotes them;
 * names it doesn't know answer NXDOMAIN.
 */
export async function startDnsFake(): Promise<DnsFake> {
  const records = new Map<string, string[]>();
  let failing = false;
  const txt = (name: string, values: string[]) => {
    if (values.length > 0) {
      records.set(name.toLowerCase(), values);
    } else {
      records.delete(name.toLowerCase());
    }
  };

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
    if (failing) {
      return json(503, {});
    }
    const name = (url.searchParams.get("name") ?? "").toLowerCase().replace(/\.$/, "");
    if (url.searchParams.get("type") !== "TXT" || request.headers.accept !== "application/dns-json") {
      return json(400, {});
    }
    const values = records.get(name);
    json(200, {
      Status: values ? 0 : 3,
      Answer: values?.map((value) => ({ name: `${name}.`, type: 16, TTL: 300, data: `"${value.replace(/["\\]/g, "\\$&")}"` })),
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}/dns-query`,
    txt,
    fail: (value) => {
      failing = value;
    },
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}
