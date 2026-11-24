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
  /** Changelogs: /collections lists them too, as Ferndesk does. */
  changelogs: Row[];
  /** Their entries, newest first, with `changelogId`: /articles lists them too. */
  entries: Row[];
  /** The helpdesk's conversations, newest activity first, each with its timeline (`messages`, oldest first). */
  tickets: Row[];
  customers: Row[];
  teammates: Row[];
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
 * their public addresses; two help center users; an AI conversation with a user and one with an anonymous visitor; a
 * changelog in a section of its own (Changelog) with entries published (one with an image, one dated before it went
 * live) and a draft, which Ferndesk lists as a collection and articles too. Its helpdesk: an email from a customer with
 * an attached file, answered by a teammate who left a note, and still going; a chat with an anonymous visitor the AI
 * agent answered, closed, with a reply never sent; and spam.
 */
export function ferndeskFixtures(): FerndeskFixtures {
  const ines = { type: "teammate", id: "mem_ines", name: "Ines Hart", avatar_url: null };
  const rosa = { id: "cust_rosa", name: "Rosa Lind", email: "e2e-ferndesk-rosa@example.com" };
  const message = (id: string, conversation: string, author: Row, body: string, created: string, rest: Row = {}) => ({
    object: "message",
    id,
    conversation_id: conversation,
    type: "message",
    visibility: "customer",
    author,
    body_text: body,
    body_html: null,
    attachments: [],
    delivery: author.type === "customer" ? null : { status: "delivered" },
    created_at: created,
    ...rest,
  });
  const ticket = (id: string, rest: Row) => ({
    object: "conversation",
    id,
    priority: "normal",
    assignee: null,
    labels: [],
    is_spam: false,
    ai_agent: { outcome: null },
    preview: null,
    snoozed_until: null,
    closed_at: null,
    url: `https://ferndesk.com/app/inbox/${id}`,
    search: null,
    ...rest,
  });
  return {
    tickets: [
      ticket("conv_hd_invoice", {
        subject: "Invoice for October",
        status: "open",
        channel: "email",
        assignee: { id: "mem_ines", name: "Ines Hart", avatar_url: null },
        customer: rosa,
        created_at: ago(3),
        updated_at: ago(0.9),
        last_message_at: ago(0.9),
        messages: [
          message("msg_invoice_1", "conv_hd_invoice", { type: "customer", id: "cust_rosa", name: "Rosa Lind", avatar_url: null }, "Could you resend October's invoice? The total looks off.", ago(3), {
            body_html: "<p>Could you resend October's invoice? The total looks off.</p>",
            attachments: [{ object: "attachment", id: "att_1", filename: "invoice-october.png", content_type: "image/png", size_bytes: PNG.byteLength, url: `${FAKE_FERNDESK_FILES}att/invoice-october.png?sig=abc` }],
          }),
          message("note_invoice", "conv_hd_invoice", ines, "Asked billing to check the total.", ago(2.5), { type: "note", visibility: "team", delivery: null }),
          message("msg_invoice_2", "conv_hd_invoice", ines, "Here it is, with the total fixed.", ago(2), { body_html: "<p>Here it is, with the total fixed.</p>" }),
          message("msg_invoice_3", "conv_hd_invoice", { type: "customer", id: "cust_rosa", name: "Rosa Lind", avatar_url: null }, "Thanks! And September's?", ago(1)),
          // Only a file, which Ferndesk gives no address for.
          message("msg_invoice_4", "conv_hd_invoice", { type: "customer", id: "cust_rosa", name: "Rosa Lind", avatar_url: null }, "", ago(0.9), {
            attachments: [{ object: "attachment", id: "att_2", filename: "september.pdf", content_type: "application/pdf", size_bytes: 1000, url: null }],
          }),
        ],
      }),
      ticket("conv_hd_chat", {
        subject: null,
        status: "closed",
        channel: "chat",
        customer: null,
        ai_agent: { outcome: "resolved" },
        created_at: ago(6),
        updated_at: ago(6),
        last_message_at: ago(6),
        closed_at: ago(6),
        messages: [
          message("msg_chat_1", "conv_hd_chat", { type: "customer", id: null, name: null, avatar_url: null }, "Is there a dark mode?", ago(6.003)),
          message("msg_chat_2", "conv_hd_chat", { type: "ai_agent", id: null, name: "Fern", avatar_url: null }, "Yes: Settings → Appearance.", ago(6.002)),
          message("msg_chat_3", "conv_hd_chat", ines, "Drafted, never sent.", ago(6.001), { delivery: { status: "cancelled" } }),
          message("msg_chat_4", "conv_hd_chat", { type: "system", id: null, name: null, avatar_url: null }, "Conversation closed.", ago(6)),
        ],
      }),
      ticket("conv_hd_spam", { subject: "Cheap watches", status: "open", channel: "email", is_spam: true, customer: null, created_at: ago(4), updated_at: ago(4), last_message_at: ago(4), messages: [] }),
    ],
    customers: [{ object: "customer", ...rosa, properties: { plan: "team" }, created_at: ago(3), updated_at: ago(3) }],
    teammates: [
      { object: "teammate", id: "mem_ines", name: "Ines Hart", email: "e2e-ferndesk-ines@example.com", avatar_url: null, role: "admin", status: "active" },
      { object: "teammate", id: "mem_olaf", name: "Olaf Brandt", email: "e2e-ferndesk-olaf@example.com", avatar_url: null, role: "contributor", status: "removed" },
    ],
    sections: [
      { id: "sect_guides", name: "Guides", position: 0, isDefault: true, iconData: null, ...at("2024-01-01T09:00:00.000Z") },
      { id: "sect_api", name: "API", position: 1, isDefault: false, iconData: null, ...at("2024-01-02T09:00:00.000Z") },
      { id: "sect_changelog", name: "Changelog", position: 2, isDefault: false, iconData: null, ...at("2024-01-02T10:00:00.000Z") },
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
      // A slug that starts with a number keeps it.
      article("art_roadmap", "Roadmap notes", "2027-roadmap-notes", "rdm01", {
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
      art_card: [{ id: "drft_card", language: null, status: "open", baseVersion: 2, source: "editor", stale: false, title: null, contentHtml: `<p>Cards are charged on the 1st. Amex is coming soon.</p><p><img src="${FAKE_FERNDESK_FILES}user-images/amex.png" alt="Amex"></p>`, updatedAt: ago(1) }],
      // Opened, never edited: nothing of its own.
      art_keys: [{ id: "drft_keys", language: null, status: "open", baseVersion: 1, source: "editor", stale: false, title: null, contentHtml: "<p>Make one in Developers.</p>", updatedAt: ago(1) }],
      // Published past since: not its unpublished changes.
      art_welcome: [{ id: "drft_old", language: null, status: "open", baseVersion: 1, source: "editor", stale: true, title: "Old welcome", contentHtml: "<p>Outdated.</p>", updatedAt: ago(30) }],
    },
    users: [
      // Tobias never verified his address: Ferndesk's lead.
      { id: "hcusr_mira", helpdeskId: "help_1", email: "e2e-ferndesk-mira@example.com", name: "Mira Fenwick", emailVerified: true, disabled: false, attributes: { plan: "pro" }, lastLoginAt: ago(2), ...at(ago(40)) },
      { id: "hcusr_tobias", helpdeskId: "help_1", email: "e2e-ferndesk-tobias@example.com", name: "Tobias Quill", emailVerified: false, disabled: false, attributes: {}, lastLoginAt: null, ...at(ago(50)) },
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
    changelogs: [{ id: "col_changelog", title: "Changelog", subtitle: "What's new in Acme", slug: "changelog", sectionId: "sect_changelog", url: `${FAKE_FERNDESK_SITE}/changelog-chg01`, ...at("2024-01-06T09:00:00.000Z") }],
    entries: [
      // Only a draft yet: its live title and body are empty until it's first published.
      {
        id: "art_sso",
        changelogId: "col_changelog",
        title: "Single sign-on",
        slug: "single-sign-on",
        contentHtml: "",
        status: "draft",
        date: null,
        tags: [],
        announce: false,
        publishedAt: null,
        draft: { id: "drft_sso", title: "Single sign-on (beta)", contentHtml: "<p>Coming soon.</p>", source: "editor", updatedAt: "2024-04-12T09:00:00.000Z" },
        ...at("2024-04-12T09:00:00.000Z"),
      },
      {
        id: "art_search",
        changelogId: "col_changelog",
        title: "Faster search",
        slug: "faster-search",
        contentHtml: `<p>Search results load twice as fast.</p><p><img src="${FAKE_FERNDESK_FILES}user-images/search.png" alt="Search"></p>`,
        status: "published",
        date: "2024-04-10",
        tags: ["new"],
        announce: true,
        publishedAt: "2024-04-10T15:00:00.000Z",
        draft: null,
        ...at("2024-04-10T15:00:00.000Z"),
      },
      // Shown on the day before it went live.
      {
        id: "art_exports",
        changelogId: "col_changelog",
        title: "Exports",
        slug: "exports",
        contentHtml: "<p>Exports take half the time.</p>",
        status: "published",
        date: "2024-04-02",
        tags: ["improvement", "fix"],
        announce: false,
        publishedAt: "2024-04-03T09:00:00.000Z",
        draft: null,
        ...at("2024-04-03T09:00:00.000Z"),
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
  /** Whether the workspace turned its helpdesk on: off, its conversations, customers and teammates answer 404. */
  helpdesk: boolean;
  close(): Promise<void>;
};

const LISTS: Record<string, keyof FerndeskFixtures> = {
  "/v1/sections": "sections",
  "/v1/collections": "collections",
  "/v1/articles": "articles",
  "/v1/users": "users",
  "/v1/assistant/conversations": "conversations",
  "/v1/changelogs": "changelogs",
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
    const helpdesk = /^\/v1\/(conversations|customers|teammates)(\/|$)/.exec(url.pathname);
    if (helpdesk) {
      if (!fake.helpdesk) {
        return send(404, { error: { type: "not_found", code: "support_not_enabled", message: "Helpdesk is not turned on in this workspace." } });
      }
      const [kind, id, sub] = url.pathname.split("/").slice(2).map(decodeURIComponent);
      const notFound = () => send(404, { error: { type: "not_found", code: "not_found", message: "Not found" } });
      // Its lists page with limit and cursor.
      const list = (rows: Row[]) => {
        const size = Math.min(Number(url.searchParams.get("limit") ?? 20), 100, fake.pageSize);
        const cursor = url.searchParams.get("cursor");
        const start = cursor ? Number(Buffer.from(cursor, "base64url").toString()) : 0;
        const more = start + size < rows.length;
        return send(200, { object: "list", data: rows.slice(start, start + size), has_more: more, next_cursor: more ? Buffer.from(String(start + size)).toString("base64url") : null });
      };
      if (kind === "teammates") {
        return send(200, { object: "list", data: fixtures.teammates.filter((t) => url.searchParams.get("include_removed") === "true" || t.status === "active"), has_more: false, next_cursor: null });
      }
      const rows = kind === "customers" ? fixtures.customers : fixtures.tickets;
      if (!id) {
        // Spam is left out unless asked for; a conversation is listed without its timeline.
        return list(kind === "customers" ? rows : rows.filter((row) => !row.is_spam).map(({ messages: _, ...row }) => row));
      }
      const one = rows.find((row) => row.id === id);
      if (!one) {
        return notFound();
      }
      if (sub === "messages") {
        return list(one.messages as Row[]);
      }
      const { messages: _, ...row } = one;
      return send(200, row);
    }
    const byStatus = (rows: Row[]) => rows.filter((row) => [row.status, "all"].includes(url.searchParams.get("status") ?? "published"));
    const entriesOf = /^\/v1\/changelogs\/([^/]+)\/entries$/.exec(url.pathname)?.[1];
    const list = LISTS[url.pathname];
    if (list || entriesOf) {
      let rows = list ? (fixtures[list] as Row[]) : byStatus(fixtures.entries.filter((row) => row.changelogId === decodeURIComponent(entriesOf!)));
      // Changelogs are collections, their entries articles: listed with them.
      if (list === "collections") {
        rows = [...rows, ...fixtures.changelogs.map(({ id, sectionId, title, subtitle, createdAt, updatedAt }) => ({ id, sectionId, parentCollectionId: null, title, subtitle, shortId: "chg01", createdAt, updatedAt }))];
      }
      if (list === "articles") {
        const entries = fixtures.entries.map(({ id, changelogId, title, slug, contentHtml, status, publishedAt, createdAt, updatedAt }) => ({
          id,
          title,
          slug,
          url: `${FAKE_FERNDESK_SITE}/${slug}`,
          sectionId: fixtures.changelogs.find((log) => log.id === changelogId)?.sectionId ?? null,
          collectionId: changelogId,
          status,
          layout: "default",
          contentHtml,
          publishedAt,
          createdAt,
          updatedAt,
        }));
        rows = byStatus([...rows, ...entries]);
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
    helpdesk: true,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
  return fake;
}
