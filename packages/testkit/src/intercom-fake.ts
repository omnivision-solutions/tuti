import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

/** The access token the fake accepts; any other is refused (401), as Intercom refuses a bad one. */
export const FAKE_INTERCOM_TOKEN = "fake_intercom_token";
/** Where the fixtures' images are: the fake serves them at its own `<url>/files/`, written into what it sends. */
export const FAKE_INTERCOM_FILES = "https://downloads.intercom-fake.invalid/";
/** A small green PNG (96×64), for the fixtures' images and avatar. */
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAGAAAABACAIAAABqVuVZAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAaUlEQVR42u3QMQ0AAAgDsInDE55QiQNujiZV0NQ0hygQJEiQIEGCBAlCkCBBggQJEiQIQYIECRIkSJAgBAkSJEiQIEGCBCFIkCBBggQJEoQgQYIECRIkSBCCBAkSJEiQIEGCECRIkKB/Flv/efAam8K1AAAAAElFTkSuQmCC", "base64");

type Row = Record<string, unknown>;

/** What the fake serves, made up, in Intercom's shapes (dates in Unix seconds). */
export type IntercomFixtures = { admins: Row[]; contacts: Row[]; companies: Row[]; collections: Row[]; articles: Row[] };

const at = (iso: string) => Math.floor(Date.parse(iso) / 1000);
const HELP = "https://intercom.help/acme/en";

/** Two admins; three contacts (a user of the team's app with a company, a lead, a user without an id there); a help center. */
export const intercomFixtures = (): IntercomFixtures => ({
  admins: [
    { type: "admin", id: "9001", name: "Ada Admin", email: "e2e-ada-intercom@example.com" },
    { type: "admin", id: "9002", name: "Ben Builder", email: "e2e-ben-intercom@example.com" },
  ],
  contacts: [
    {
      type: "contact",
      id: "6650000000000000000000a1",
      external_id: "app-user-1",
      role: "user",
      name: "Mira Patel",
      email: "e2e-mira-intercom@example.com",
      avatar: `${FAKE_INTERCOM_FILES}mira.png`,
      custom_attributes: { plan: "Pro", seats: 12, churned: null },
      companies: { type: "list", data: [{ type: "company", id: "c-1", url: "/companies/c-1" }], total_count: 1, has_more: false },
    },
    { type: "contact", id: "6650000000000000000000a2", external_id: null, role: "lead", name: "Leo Lead", email: "e2e-leo-intercom@example.com", avatar: null, custom_attributes: {}, companies: { data: [] } },
    { type: "contact", id: "6650000000000000000000a3", external_id: null, role: "user", name: "Tobias Weber", email: "e2e-tobias-intercom@example.com", avatar: null, custom_attributes: { team: "Design" }, companies: { data: [] } },
  ],
  companies: [{ type: "company", id: "c-1", name: "Initech" }],
  collections: [
    { type: "collection", id: "101", parent_id: null, name: "Getting started", description: "Your first steps.", url: `${HELP}/collections/101-getting-started`, order: 0, created_at: at("2024-02-01T09:00:00Z") },
    { type: "collection", id: "103", parent_id: "102", name: "Invoices", description: "Finding and paying them.", url: `${HELP}/collections/103-invoices`, order: 0, created_at: at("2024-02-01T09:00:00Z") },
    { type: "collection", id: "102", parent_id: null, name: "Billing", description: "Plans and payments.", url: `${HELP}/collections/102-billing`, order: 1, created_at: at("2024-02-01T09:00:00Z") },
  ],
  // Newest updated first, as Intercom lists them.
  articles: [
    {
      type: "article",
      id: "201",
      title: "Welcome to Acme",
      description: "What Acme does, in a minute.",
      body: `<h1>Start here</h1><p>Acme keeps every invoice in one place. See <a href="${HELP}/articles/202-paying-by-card">Paying by card</a> or <a href="${HELP}/collections/102-billing">Billing</a>.</p><p><img src="${FAKE_INTERCOM_FILES}welcome.png" alt="The dashboard"></p>`,
      author_id: 9001,
      state: "published",
      url: `${HELP}/articles/201-welcome-to-acme`,
      parent_ids: [101],
      help_center_audience: "everyone",
      created_at: at("2024-03-01T09:00:00Z"),
      updated_at: at("2024-03-04T09:00:00Z"),
    },
    {
      type: "article",
      id: "202",
      title: "Paying by card",
      description: "Cards we take.",
      body: "<p>We take Visa and Mastercard.</p>",
      author_id: 9002,
      state: "published",
      url: `${HELP}/articles/202-paying-by-card`,
      parent_ids: [103],
      help_center_audience: "everyone",
      created_at: at("2024-03-01T10:00:00Z"),
      updated_at: at("2024-03-03T09:00:00Z"),
    },
    {
      type: "article",
      id: "203",
      title: "Refunds (coming soon)",
      description: "",
      body: "<p>Not ready yet.</p>",
      author_id: 9001,
      state: "draft",
      url: null,
      parent_ids: [102],
      help_center_audience: "everyone",
      created_at: at("2024-03-01T11:00:00Z"),
      updated_at: at("2024-03-02T09:00:00Z"),
    },
    {
      type: "article",
      id: "204",
      title: "Enterprise contracts",
      description: "",
      body: "<p>For customers only.</p>",
      author_id: 9001,
      state: "published",
      url: `${HELP}/articles/204-enterprise-contracts`,
      parent_ids: [102],
      help_center_audience: "all_users",
      created_at: at("2024-03-01T12:00:00Z"),
      updated_at: at("2024-03-01T13:00:00Z"),
    },
  ],
});

export type IntercomFake = {
  url: string;
  env: { INTERCOM_API_URL: string };
  /** What it serves; change it freely. */
  fixtures: IntercomFixtures;
  /** A page holds at most this many, so a few fixtures make several pages. */
  pageSize: number;
  /** Requests made, as `GET /contacts?per_page=150&…`. */
  requests: string[];
  close(): Promise<void>;
};

/** A local stand-in for Intercom's REST API: it checks the token and serves fixtures, contacts by cursor, the help center by page number. */
export async function startIntercomFake(): Promise<IntercomFake> {
  const files = new Map([
    ["mira.png", PNG],
    ["welcome.png", PNG],
  ]);
  const server = createServer((req, res) => {
    const send = (status: number, body: unknown) =>
      res.writeHead(status, { "Content-Type": "application/json" }).end(JSON.stringify(body).replaceAll(FAKE_INTERCOM_FILES, `${fake.url}/files/`));
    const url = new URL(req.url ?? "/", "http://fake");
    const notFound = () => send(404, { type: "error.list", errors: [{ code: "not_found", message: "Resource Not Found" }] });
    if (url.pathname.startsWith("/files/")) {
      const file = files.get(url.pathname.slice("/files/".length));
      return file ? res.writeHead(200, { "Content-Type": "image/png" }).end(file) : notFound();
    }
    fake.requests.push(`${req.method} ${url.pathname}${url.search}`);
    if (req.headers.authorization !== `Bearer ${FAKE_INTERCOM_TOKEN}`) {
      return send(401, { type: "error.list", errors: [{ code: "unauthorized", message: "Access Token Invalid" }] });
    }
    const { fixtures } = fake;
    const perPage = Math.min(Number(url.searchParams.get("per_page") ?? 20), fake.pageSize);
    /** A help center list's page, by number. */
    const numbered = (rows: Row[]) => {
      const page = Number(url.searchParams.get("page") ?? 1);
      return send(200, { type: "list", pages: { type: "pages", page, per_page: perPage, total_pages: Math.max(1, Math.ceil(rows.length / perPage)) }, total_count: rows.length, data: rows.slice((page - 1) * perPage, page * perPage) });
    };
    const one = (rows: Row[], prefix: string) => {
      const row = rows.find((r) => String(r.id) === decodeURIComponent(url.pathname.slice(prefix.length)));
      return row ? send(200, row) : notFound();
    };
    if (url.pathname === "/me") {
      return send(200, { type: "admin", ...fixtures.admins[0] });
    }
    if (url.pathname === "/admins") {
      return send(200, { type: "admin.list", admins: fixtures.admins });
    }
    if (url.pathname === "/contacts") {
      const after = url.searchParams.get("starting_after");
      const start = after ? Number(Buffer.from(after, "base64url").toString()) : 0;
      const end = start + perPage;
      const next = end < fixtures.contacts.length ? { page: 2, starting_after: Buffer.from(String(end)).toString("base64url") } : undefined;
      return send(200, { type: "list", data: fixtures.contacts.slice(start, end), total_count: fixtures.contacts.length, pages: { type: "pages", per_page: perPage, ...(next && { next }) } });
    }
    if (url.pathname.startsWith("/companies/")) {
      return one(fixtures.companies, "/companies/");
    }
    if (url.pathname === "/help_center/collections") {
      return numbered(fixtures.collections);
    }
    if (url.pathname === "/articles") {
      return numbered(fixtures.articles);
    }
    if (url.pathname.startsWith("/articles/")) {
      return one(fixtures.articles, "/articles/");
    }
    return notFound();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const fake: IntercomFake = {
    url,
    env: { INTERCOM_API_URL: url },
    fixtures: intercomFixtures(),
    pageSize: 150,
    requests: [],
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
  return fake;
}
