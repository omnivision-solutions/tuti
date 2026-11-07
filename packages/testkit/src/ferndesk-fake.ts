import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

/** The API key the fake accepts; any other is refused (401), as Ferndesk refuses a bad one. */
export const FAKE_FERNDESK_KEY = "fdsk_fake_ferndesk";

type Row = Record<string, unknown>;

/** What the fake serves, made up. */
export type FerndeskFixtures = {
  sections: Row[];
  collections: Row[];
  /** Current versions, published and drafts, newest first as GET /v1/articles lists them. */
  articles: Row[];
  /** Open drafts (with their body), by article id. */
  drafts: Record<string, Row[]>;
  users: Row[];
  /** With their transcripts, newest first. */
  conversations: Row[];
};

/** Where the fixtures' images are: written into what the fake sends as its own `<url>/files/`. */
export const FAKE_FERNDESK_FILES = "https://static.ferndesk-fake.invalid/";
/** Its help center's public address, as articles' `url`s and links between them have it. */
export const FAKE_FERNDESK_SITE = "https://help.acme.example";
/** A small green PNG (96×64). */
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAGAAAABACAIAAABqVuVZAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAaUlEQVR42u3QMQ0AAAgDsInDE55QiQNujiZV0NQ0hygQJEiQIEGCBAlCkCBBggQJEiQIQYIECRIkSJAgBAkSJEiQIEGCBCFIkCBBggQJEoQgQYIECRIkSBCCBAkSJEiQIEGCECRIkKB/Flv/efAam8K1AAAAAElFTkSuQmCC",
  "base64",
);

const DAY_MS = 86_400_000;
const ago = (days: number) => new Date(Date.now() - days * DAY_MS).toISOString();
const at = (date: string) => ({ createdAt: date, updatedAt: date });
const article = (id: string, title: string, slug: string, shortId: string, rest: Row) => ({
  id,
  title,
  slug,
  url: `${FAKE_FERNDESK_SITE}/${slug}-${shortId}`,
  sectionId: "sect_guides",
  collectionId: null,
  status: "published",
  layout: "default",
  publishedAt: null,
  ...rest,
});

/**
 * Made-up fixtures: two sections (Guides, with Getting started and Billing › Invoices; API, with an article in no
 * collection), articles published and draft, one with an open draft and one with a stale one, linking to each other by
 * their public addresses; two help center users; an AI conversation with a user and one with an anonymous visitor.
 */
export function ferndeskFixtures(): FerndeskFixtures {
  return {
    sections: [
      { id: "sect_guides", name: "Guides", position: 0, isDefault: true, iconData: null, ...at("2024-01-01T09:00:00.000Z") },
      { id: "sect_api", name: "API", position: 1, isDefault: false, iconData: null, ...at("2024-01-02T09:00:00.000Z") },
    ],
    collections: [
      { id: "col_invoices", sectionId: "sect_guides", parentCollectionId: "col_billing", title: "Invoices", subtitle: "Finding and paying them.", shortId: "inv01", ...at("2024-01-05T09:00:00.000Z") },
      { id: "col_billing", sectionId: "sect_guides", parentCollectionId: null, title: "Billing", subtitle: "Plans and payments.", shortId: "bil01", ...at("2024-01-04T09:00:00.000Z") },
      { id: "col_start", sectionId: "sect_guides", parentCollectionId: null, title: "Getting started", subtitle: null, shortId: "gst01", ...at("2024-01-03T09:00:00.000Z") },
    ],
    articles: [
      article("art_keys", "API keys", "api-keys", "key01", {
        sectionId: "sect_api",
        contentHtml: "<p>Make one in Developers.</p>",
        ...at("2024-03-04T09:00:00.000Z"),
      }),
      article("art_roadmap", "Roadmap notes", "roadmap-notes", "rdm01", {
        collectionId: "col_start",
        status: "draft",
        contentHtml: "<p>Not ready yet.</p>",
        ...at("2024-03-03T09:00:00.000Z"),
      }),
      article("art_card", "Paying by card", "paying-by-card", "pay01", {
        collectionId: "col_invoices",
        contentHtml: `<p>Cards are charged on the 1st. See <a href="${FAKE_FERNDESK_SITE}/welcome-to-acme-wel01">Welcome to Acme</a>.</p>`,
        ...at("2024-03-02T09:00:00.000Z"),
      }),
      article("art_welcome", "Welcome to Acme", "welcome-to-acme", "wel01", {
        collectionId: "col_start",
        contentHtml: `<h2>Start here</h2><p>Acme keeps every invoice in one place. Read <a href="${FAKE_FERNDESK_SITE}/paying-by-card-pay01">Paying by card</a> or browse <a href="/billing-bil01">Billing</a>; <a href="https://example.com/a-blog-post">our blog</a> stays as it is.</p><p><img src="${FAKE_FERNDESK_FILES}user-images/welcome.png" alt="The dashboard"></p>`,
        createdAt: "2024-03-01T09:00:00.000Z",
        updatedAt: "2024-03-02T09:00:00.000Z",
      }),
    ],
    drafts: {
      art_card: [{ id: "drft_card", language: null, status: "open", baseVersion: 2, source: "editor", stale: false, title: null, contentHtml: "<p>Cards are charged on the 1st. Amex is coming soon.</p>", updatedAt: ago(1) }],
      // Published past since: not its unpublished changes.
      art_welcome: [{ id: "drft_old", language: null, status: "open", baseVersion: 1, source: "editor", stale: true, title: "Old welcome", contentHtml: "<p>Outdated.</p>", updatedAt: ago(30) }],
    },
    users: [
      { id: "hcusr_mira", helpdeskId: "help_1", email: "e2e-ferndesk-mira@example.com", name: "Mira Fenwick", emailVerified: true, disabled: false, attributes: { plan: "pro" }, lastLoginAt: ago(2), ...at(ago(40)) },
      { id: "hcusr_tobias", helpdeskId: "help_1", email: "e2e-ferndesk-tobias@example.com", name: "Tobias Quill", emailVerified: true, disabled: false, attributes: {}, lastLoginAt: null, ...at(ago(50)) },
    ],
    conversations: [
      {
        id: "conv_mira",
        createdAt: ago(2),
        updatedAt: ago(2),
        status: "active",
        source: "widget",
        pageUrl: null,
        user: { id: "hcusr_mira", name: "Mira Fenwick" },
        summary: "Asked how to export to CSV.",
        coverage: "covered",
        feedback: null,
        escalated: false,
        messageCount: 1,
        transcript: [
          { role: "user", text: "Can I export my data to CSV?" },
          { role: "assistant", text: "Yes: Settings → Export.\nIt takes a minute." },
        ],
        references: [],
      },
      {
        id: "conv_visitor",
        createdAt: ago(5),
        updatedAt: ago(5),
        status: "active",
        source: "widget",
        pageUrl: null,
        user: null,
        summary: null,
        coverage: "none",
        feedback: null,
        escalated: false,
        messageCount: 1,
        transcript: [
          { role: "user", text: "Do you have an <API>?" },
          { role: "assistant", text: "Yes, see API keys." },
        ],
        references: [],
      },
    ],
  };
}

export type FerndeskFake = {
  url: string;
  env: { FERNDESK_API_URL: string };
  /** What it serves; change it freely. */
  fixtures: FerndeskFixtures;
  /** A page holds at most this many (Ferndesk: 100). */
  pageSize: number;
  /** Requests made, as `GET /v1/articles?status=all&…`. */
  requests: string[];
  /** Paths answered 403 (e.g. "/v1/users"), as for a key without the scope. */
  forbidden: Set<string>;
  close(): Promise<void>;
};

const LISTS: Record<string, keyof FerndeskFixtures> = {
  "/v1/sections": "sections",
  "/v1/collections": "collections",
  "/v1/articles": "articles",
  "/v1/users": "users",
  "/v1/assistant/conversations": "conversations",
};

/** A local stand-in for Ferndesk's public API (v1): it checks the key and serves fixtures, paged with opaque cursors. */
export async function startFerndeskFake(): Promise<FerndeskFake> {
  const server = createServer((req, res) => {
    const send = (status: number, body: unknown) => res.writeHead(status, { "Content-Type": "application/json" }).end(JSON.stringify(body).replaceAll(FAKE_FERNDESK_FILES, `${fake.url}/files/`));
    const url = new URL(req.url ?? "/", "http://fake");
    if (url.pathname.startsWith("/files/")) {
      return res.writeHead(200, { "Content-Type": "image/png" }).end(PNG);
    }
    fake.requests.push(`${req.method} ${url.pathname}${url.search}`);
    if (req.headers.authorization !== `Bearer ${FAKE_FERNDESK_KEY}`) {
      return send(401, { error: "Unauthorized", code: "unauthorized" });
    }
    if (fake.forbidden.has(url.pathname)) {
      return send(403, { error: "This endpoint requires the `content:write` scope.", code: "missing_scope", scope: "content:write" });
    }
    if (req.method !== "GET") {
      return send(405, { error: "the fake is read-only" });
    }
    const { fixtures } = fake;
    const list = LISTS[url.pathname];
    if (list) {
      let rows = fixtures[list] as Row[];
      if (list === "articles") {
        const status = url.searchParams.get("status") ?? "published";
        rows = rows.filter((row) => status === "all" || row.status === status);
      }
      // The list leaves out transcripts.
      if (list === "conversations") {
        rows = rows.map(({ transcript: _, references: __, ...row }) => row);
      }
      const size = Math.min(Number(url.searchParams.get("page_size") ?? 20), 100, fake.pageSize);
      const cursor = url.searchParams.get("start_cursor");
      const start = cursor ? Number(Buffer.from(cursor, "base64url").toString()) : 0;
      const end = start + size;
      const more = end < rows.length;
      return send(200, { results: rows.slice(start, end), has_more: more, next_cursor: more ? Buffer.from(String(end)).toString("base64url") : null });
    }
    if (url.pathname === "/v1/articles/languages") {
      return send(200, { default: "en", languages: [{ language: "en", displayName: "English", isDefault: true, isEnabled: true }] });
    }
    const [, kind, id, sub, subId] = url.pathname.split("/").slice(1).map(decodeURIComponent);
    const notFound = () => send(404, { error: "Not found", code: "not_found" });
    if (kind === "articles" && id) {
      const found = fixtures.articles.find((row) => row.id === id);
      if (!found) {
        return notFound();
      }
      if (sub === "drafts") {
        const drafts = fixtures.drafts[id] ?? [];
        if (!subId) {
          return send(200, drafts.map(({ title: _, contentHtml: __, ...draft }) => draft));
        }
        const draft = drafts.find((row) => row.id === subId);
        return draft ? send(200, draft) : notFound();
      }
      return send(200, found);
    }
    const rows = kind === "users" ? fixtures.users : kind === "assistant" && id === "conversations" ? fixtures.conversations : null;
    const one = rows?.find((row) => row.id === (kind === "assistant" ? sub : id));
    return one ? send(200, one) : notFound();
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const fake: FerndeskFake = {
    url,
    env: { FERNDESK_API_URL: url },
    fixtures: ferndeskFixtures(),
    pageSize: 100,
    requests: [],
    forbidden: new Set(),
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
  return fake;
}
