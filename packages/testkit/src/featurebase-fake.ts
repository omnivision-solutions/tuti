import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

/** The API key the fake accepts; any other is refused (401), as Featurebase refuses a bad one. */
export const FAKE_FEATUREBASE_KEY = "sk_fake_featurebase";
/** A key the fake also takes whose pages of a list (100 at a time, as an import reads; not a start's checks) answer 4 seconds late: an import that's still running when the page looks again. */
export const FAKE_FEATUREBASE_SLOW_KEY = "sk_fake_featurebase_slow";

type Row = Record<string, unknown>;

/** What the fake serves, made up. Imports of more parts add theirs (boards, posts, articles, conversations, …). */
export type FeaturebaseFixtures = { contacts: (Row | null)[]; admins: Row[] };

/** Made-up contacts: one with everything (properties of each kind, two companies, an uploaded avatar), one with Featurebase's placeholder avatar, a lead with no email or id of their own, and an empty row (Featurebase sends some). */
export const featurebaseFixtures = (): FeaturebaseFixtures => ({
  contacts: [
    {
      object: "contact",
      id: "65f000000000000000000001",
      userId: "app-user-1",
      type: "customer",
      name: "Mira Fenwick",
      email: "e2e-mira@example.com",
      profilePicture: "https://images.example.com/mira.png",
      customFields: { plan: "pro", seats: 12, beta: true, features: ["sso", "audit"], nested: { no: true }, notes: "x".repeat(201) },
      companies: [{ object: "company", id: "65f0000000000000000000c1", name: "Fenwick Labs" }, { object: "company", id: "65f0000000000000000000c2", name: "Side Gig" }],
    },
    {
      object: "contact",
      id: "65f000000000000000000002",
      userId: "app-user-2",
      type: "customer",
      name: "Tobias Quill",
      email: "e2e-tobias@example.com",
      profilePicture: "https://global.featurebase-attachments.com/a/shapes/3_200_200.png",
      // A company sent as a custom field, without Featurebase's companies.
      customFields: { plan: "free", company: "Globex" },
      companies: [],
    },
    null,
    { object: "contact", id: "65f000000000000000000003", type: "lead", name: "Juno Park", email: null, profilePicture: null, customFields: {}, companies: [] },
  ],
  admins: [
    { object: "admin", id: "65f0000000000000000000a1", name: "Olive Owner", email: "e2e-featurebase-owner@example.com", profilePicture: null, roleId: "owner" },
    { object: "admin", id: "65f0000000000000000000a2", name: "Fern Former", email: "e2e-featurebase-former@example.com", profilePicture: null, roleId: "admin" },
  ],
});

/** Lists the fake serves, by path: paged ones as Featurebase pages them; unpaged ones (admins) in one. */
const LISTS: Record<string, { fixtures: keyof FeaturebaseFixtures; paged: boolean }> = {
  "/v2/contacts": { fixtures: "contacts", paged: true },
  "/v2/admins": { fixtures: "admins", paged: false },
};

export type FeaturebaseFake = {
  url: string;
  env: { FEATUREBASE_API_URL: string };
  /** What it serves; change it freely. */
  fixtures: FeaturebaseFixtures;
  /** A page holds at most this many (Featurebase: 100), so a few fixtures make several pages. */
  pageSize: number;
  /** Requests made, as `GET /v2/contacts?limit=100&…`. */
  requests: string[];
  /** Lists answered 403 with their items (e.g. "/v2/contacts"), as for a key that can't read them. */
  forbidden: Set<string>;
  /**
   * The next `times` API requests answer `status` (e.g. 429, 500), with these response headers (Retry-After,
   * X-RateLimit-Reset) and `body` as it is (default an error's JSON): a 200 with a cut-off body, an empty page.
   */
  failNext(status: number, times?: number, headers?: Record<string, string>, body?: string): void;
  /** Runs between a failing answer's headers and its body (sent a moment later): time passing as the body is read. */
  beforeBody?: () => void;
  /** Serves a file at `<url>/files/<name>` (no key, like Featurebase's attachments' links); returns its address. */
  file(name: string, type: string, body: Buffer): string;
  close(): Promise<void>;
};

/** A local stand-in for Featurebase's API (v2): it checks the key and serves fixtures, paged with opaque cursors. */
export async function startFeaturebaseFake(): Promise<FeaturebaseFake> {
  const files = new Map<string, { type: string; body: Buffer }>();
  let failing: { status: number; times: number; headers: Record<string, string>; body?: string } | undefined;

  const server = createServer((req, res) => {
    const send = (status: number, body: unknown) => res.writeHead(status, { "Content-Type": "application/json" }).end(JSON.stringify(body));
    const url = new URL(req.url ?? "/", "http://fake");
    if (req.method === "GET" && url.pathname.startsWith("/files/")) {
      const file = files.get(decodeURIComponent(url.pathname.slice("/files/".length)));
      return file ? res.writeHead(200, { "Content-Type": file.type }).end(file.body) : send(404, { message: "no such file" });
    }
    fake.requests.push(`${req.method} ${url.pathname}${url.search}`);
    const slow = req.headers.authorization === `Bearer ${FAKE_FEATUREBASE_SLOW_KEY}`;
    if (req.headers.authorization !== `Bearer ${FAKE_FEATUREBASE_KEY}` && !slow) {
      return send(401, { success: false, message: "Invalid API key" });
    }
    if (slow && url.searchParams.get("limit") === "100" && !req.headers["x-fake-late"]) {
      req.headers["x-fake-late"] = "1";
      setTimeout(() => server.emit("request", req, res), 4_000);
      fake.requests.pop();
      return;
    }
    if (failing) {
      const { status, headers, body } = failing;
      failing = --failing.times > 0 ? failing : undefined;
      const text = body ?? JSON.stringify({ error: { type: "api_error", message: "fake failure", status } });
      res.writeHead(status, { "Content-Type": "application/json", ...headers });
      if (!fake.beforeBody) {
        return res.end(text);
      }
      res.flushHeaders();
      const before = fake.beforeBody;
      setTimeout(() => {
        before();
        res.end(text);
      }, 50);
      return;
    }
    if (req.method !== "GET") {
      return send(405, { message: "the fake is read-only" });
    }
    const list = LISTS[url.pathname];
    const parent = url.pathname.slice(0, url.pathname.lastIndexOf("/"));
    const path = list ? url.pathname : parent;
    if (fake.forbidden.has(path)) {
      return send(403, { error: { type: "authorization_error", message: "Your API key can't read this", status: 403 } });
    }
    if (list) {
      const rows = fake.fixtures[list.fixtures];
      if (!list.paged) {
        return send(200, { object: "list", data: rows, nextCursor: null });
      }
      const limit = Math.min(Number(url.searchParams.get("limit") ?? 10), 100, fake.pageSize);
      const cursor = url.searchParams.get("cursor");
      const start = cursor ? Number(Buffer.from(cursor, "base64url").toString()) : 0;
      const end = start + limit;
      return send(200, { object: "list", data: rows.slice(start, end), nextCursor: end < rows.length ? Buffer.from(String(end)).toString("base64url") : null });
    }
    // One item of a list: GET /v2/contacts/{id}.
    const items = LISTS[parent];
    if (items) {
      const id = decodeURIComponent(url.pathname.slice(parent.length + 1));
      const row = (fake.fixtures[items.fixtures] as (Row | null)[]).find((item) => item?.id === id);
      return row ? send(200, row) : send(404, { error: { type: "invalid_request_error", code: "resource_not_found", message: "Not found", status: 404 } });
    }
    return send(404, { message: `the fake doesn't serve ${req.method} ${url.pathname}` });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const fake: FeaturebaseFake = {
    url,
    env: { FEATUREBASE_API_URL: url },
    fixtures: featurebaseFixtures(),
    pageSize: 100,
    requests: [],
    forbidden: new Set(),
    failNext: (status, times = 1, headers = {}, body) => void (failing = { status, times, headers, body }),
    file: (name, type, body) => {
      files.set(name, { type, body });
      return `${url}/files/${encodeURIComponent(name)}`;
    },
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
  return fake;
}
