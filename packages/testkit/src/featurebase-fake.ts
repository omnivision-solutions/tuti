import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

/** The API key the fake accepts; any other is refused (401), as Featurebase refuses a bad one. */
export const FAKE_FEATUREBASE_KEY = "sk_fake_featurebase";
/**
 * A key the fake also takes whose pages of a list (100 at a time, as an import reads; not a start's checks) wait until
 * `release()` (or a POST to `<url>/_fake/release`, for journeys in other processes): an import that's running for as long
 * as a test needs. Held ones go on after a minute regardless, so nothing hangs.
 */
export const FAKE_FEATUREBASE_SLOW_KEY = "sk_fake_featurebase_slow";

type Row = Record<string, unknown>;

/** What the fake serves, made up. Imports of more parts add theirs (boards, posts, articles, conversations, …). */
export type FeaturebaseFixtures = { contacts: (Row | null)[]; admins: Row[]; boards: Row[]; posts: Row[]; comments: Row[]; voters: Record<string, Row[]> };

/**
 * Where the fixtures' images are: the fake serves its files (`file`, and FAKE_FEATUREBASE_FILES' own) at this address,
 * written into what it sends as its own `<url>/files/`.
 */
export const FAKE_FEATUREBASE_FILES = "https://files.featurebase-fake.invalid/";
/** A small green PNG (96×64), for the fixtures' images and avatar. */
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAGAAAABACAIAAABqVuVZAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAaUlEQVR42u3QMQ0AAAgDsInDE55QiQNujiZV0NQ0hygQJEiQIEGCBAlCkCBBggQJEiQIQYIECRIkSJAgBAkSJEiQIEGCBCFIkCBBggQJEoQgQYIECRIkSBCCBAkSJEiQIEGCECRIkKB/Flv/efAam8K1AAAAAElFTkSuQmCC",
  "base64",
);

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
      profilePicture: `${FAKE_FEATUREBASE_FILES}mira.png`,
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
  ...feedbackFixtures(),
});

const MIRA = { id: "65f000000000000000000001", name: "Mira Fenwick", email: "e2e-mira@example.com", profilePicture: null, type: "customer" };
const TOBIAS = { id: "65f000000000000000000002", name: "Tobias Quill", email: "e2e-tobias@example.com", profilePicture: null, type: "customer" };
const JUNO = { id: "65f000000000000000000003", name: "Juno Park", email: null, profilePicture: null, type: "lead" };
const OLIVE = { id: "65f0000000000000000000a1", name: "Olive Owner", email: "e2e-featurebase-owner@example.com", profilePicture: null, type: "admin" };
const FERN = { id: "65f0000000000000000000a2", name: "Fern Former", email: "e2e-featurebase-former@example.com", profilePicture: null, type: "admin" };
const ANOTHER_VISITOR = { id: "65f0000000000000000000g2", name: "Another visitor", email: null, profilePicture: null, type: "guest" };
const OPEN_ACCESS = { adminOnly: false, allowedRoles: [], deniedRoles: [], segments: [] };
const board = (id: string, name: string, access: Row = {}, words: Row = {}) => ({
  object: "board",
  id,
  name,
  createdAt: "2023-05-01T09:00:00.000Z",
  access: { ...OPEN_ACCESS, ...access },
  localization: { name: { en: name }, description: null, heroTitle: null, heroDescription: null, formPlaceholder: null, submitButtonText: null, ...words },
  postDefaults: { visibility: "public" },
});
const status = (name: string, type: string) => ({ object: "post_status", id: `status-${type}`, name, color: "Blue", isDefault: false, type });
const post = (id: string, boardId: string, title: string, author: Row | null, createdAt: string, rest: Row = {}) => ({
  object: "post",
  id,
  title,
  content: `<p>${title}, please.</p>`,
  boardId,
  status: status("In Review", "reviewing"),
  author,
  createdAt,
  updatedAt: createdAt,
  eta: null,
  upvotes: 1,
  commentCount: 0,
  inReview: false,
  portalHidden: false,
  access: { userIds: [], companyExternalIds: [] },
  ...rest,
});
const comment = (id: string, postId: string | null, author: Row, content: string, createdAt: string, rest: Row = {}) => ({
  object: "comment",
  id,
  postId,
  changelogId: postId ? null : "65f0000000000000000000e1",
  parentCommentId: null,
  content,
  author: { ...author, email: undefined },
  createdAt,
  updatedAt: createdAt,
  isPrivate: false,
  inReview: false,
  isSpam: false,
  isDeleted: false,
  ...rest,
});
const voter = (person: Row, createdAt: string) => ({ object: "contact", ...person, createdAt });

/**
 * Made-up feedback: five boards (one with the new project's board's name and its own words, one only admins see, one
 * for a segment, one some roles can't see); posts in date order with statuses by name and by type, an ETA, an image, an admin's and a guest's,
 * and four left out (on a hidden board, waiting for moderation, hidden from the portal, for one person); their voters
 * (the author among them, as Featurebase counts them, a guest author too; a voter made after the post; an admin; a guest); and comments:
 * a public one with an image, a reply, the team's private one, a user's private one, and ones left out (spam,
 * deleted, waiting for moderation, on a left-out post), and a changelog's.
 */
function feedbackFixtures(): Pick<FeaturebaseFixtures, "boards" | "posts" | "comments" | "voters"> {
  return {
    boards: [
      board("65f0000000000000000000b1", "Feature requests", {}, { description: { en: "Ideas for the product" }, formPlaceholder: { en: "What would help you most?" }, submitButtonText: { en: "Share an idea" } }),
      board("65f0000000000000000000b2", "Bugs"),
      board("65f0000000000000000000b3", "Internal", { adminOnly: true }),
      board("65f0000000000000000000b4", "Beta testers", { segments: ["65f0000000000000000000s1"] }),
      board("65f0000000000000000000b6", "Paid plans", { deniedRoles: ["65f0000000000000000000r1"] }),
    ],
    posts: [
      post("65f0000000000000000000p1", "65f0000000000000000000b1", "Dark mode", MIRA, "2024-01-10T08:00:00.000Z", {
        content: `<h1>Dark mode</h1><p>Night owls need it.</p><img src="${FAKE_FEATUREBASE_FILES}whiteboard.png?X-Amz-Signature=abc" alt="A sketch">`,
        status: status("Planned", "unstarted"),
        eta: "2024-06-15T00:00:00.000Z",
        upvotes: 4,
        commentCount: 2,
      }),
      post("65f0000000000000000000p2", "65f0000000000000000000b2", "Export fails on Safari", FERN, "2024-02-01T10:00:00.000Z", { status: status("Fixing", "active"), upvotes: 2 }),
      post("65f0000000000000000000p3", "65f0000000000000000000b3", "Quarterly planning", OLIVE, "2024-02-02T10:00:00.000Z"),
      post("65f0000000000000000000p4", "65f0000000000000000000b1", "Waiting for a moderator", TOBIAS, "2024-02-03T10:00:00.000Z", { inReview: true }),
      post("65f0000000000000000000p5", "65f0000000000000000000b1", "Hidden from the portal", TOBIAS, "2024-02-04T10:00:00.000Z", { portalHidden: true }),
      post("65f0000000000000000000p6", "65f0000000000000000000b2", "Only for one customer", TOBIAS, "2024-02-05T10:00:00.000Z", { access: { userIds: [TOBIAS.id], companyExternalIds: [] } }),
      post("65f0000000000000000000p7", "65f0000000000000000000b4", "Beta feature", JUNO, "2024-02-06T10:00:00.000Z"),
      post("65f0000000000000000000p8", "65f0000000000000000000b2", "Sync with calendars", JUNO, "2024-03-01T10:00:00.000Z", { status: status("Rejected", "canceled") }),
      post("65f0000000000000000000p9", "65f0000000000000000000b1", "Keyboard shortcuts", { id: null, name: "Visitor", email: null, profilePicture: null, type: "guest" }, "2024-03-05T10:00:00.000Z"),
      post("65f0000000000000000000pb", "65f0000000000000000000b1", "Export to PDF", ANOTHER_VISITOR, "2024-03-06T10:00:00.000Z"),
    ],
    voters: {
      "65f0000000000000000000p1": [
        voter(MIRA, "2023-06-01T00:00:00.000Z"),
        voter(TOBIAS, "2024-02-20T12:00:00.000Z"),
        voter(OLIVE, "2023-01-01T00:00:00.000Z"),
        voter({ id: "65f0000000000000000000g1", name: "Guest", email: null, profilePicture: null, type: "guest" }, "2024-01-11T00:00:00.000Z"),
      ],
      "65f0000000000000000000p2": [voter(FERN, "2023-01-01T00:00:00.000Z"), voter(JUNO, "2023-07-01T00:00:00.000Z")],
      "65f0000000000000000000p3": [voter(OLIVE, "2023-01-01T00:00:00.000Z")],
      "65f0000000000000000000p8": [voter(JUNO, "2023-07-01T00:00:00.000Z")],
      // A guest among their own post's voters, as Featurebase counts the author.
      "65f0000000000000000000pb": [voter(ANOTHER_VISITOR, "2024-03-06T10:00:00.000Z")],
    },
    comments: [
      comment("65f0000000000000000000c1", "65f0000000000000000000p1", TOBIAS, `<p>Yes please!</p><img src="${FAKE_FEATUREBASE_FILES}whiteboard.png">`, "2024-01-11T09:00:00.000Z"),
      comment("65f0000000000000000000c2", "65f0000000000000000000p1", OLIVE, "<p>Planning it for June.</p>", "2024-01-12T09:00:00.000Z", { isPrivate: true }),
      comment("65f0000000000000000000c3", "65f0000000000000000000p1", MIRA, "<p>Just between us: we'd pay for it.</p>", "2024-01-13T09:00:00.000Z", { isPrivate: true }),
      comment("65f0000000000000000000c4", "65f0000000000000000000p1", FERN, "<p>On our list, thanks!</p>", "2024-01-14T09:00:00.000Z", { parentCommentId: "65f0000000000000000000c1" }),
      comment("65f0000000000000000000c5", "65f0000000000000000000p2", TOBIAS, "<p>Buy cheap watches</p>", "2024-02-02T09:00:00.000Z", { isSpam: true }),
      comment("65f0000000000000000000c6", "65f0000000000000000000p2", TOBIAS, "<p>Never mind</p>", "2024-02-03T09:00:00.000Z", { isDeleted: true }),
      comment("65f0000000000000000000c7", "65f0000000000000000000p2", JUNO, "<p>Same here</p>", "2024-02-04T09:00:00.000Z", { inReview: true }),
      comment("65f0000000000000000000c8", "65f0000000000000000000p3", OLIVE, "<p>For next quarter</p>", "2024-02-05T09:00:00.000Z"),
      comment("65f0000000000000000000c9", null, TOBIAS, "<p>Nice update</p>", "2024-02-06T09:00:00.000Z"),
      comment("65f0000000000000000000ca", "65f0000000000000000000p8", JUNO, "<p>Still waiting.</p>", "2024-03-02T09:00:00.000Z"),
    ],
  };
}

/** Lists the fake serves, by path: paged ones as Featurebase pages them; unpaged ones (admins) in one; bare ones (boards) as an array. */
const LISTS: Record<string, { fixtures: Exclude<keyof FeaturebaseFixtures, "voters">; paged: boolean; bare?: true }> = {
  "/v2/contacts": { fixtures: "contacts", paged: true },
  "/v2/admins": { fixtures: "admins", paged: false },
  "/v2/boards": { fixtures: "boards", paged: false, bare: true },
  "/v2/posts": { fixtures: "posts", paged: true },
  "/v2/comments": { fixtures: "comments", paged: true },
};
const VOTERS = /^\/v2\/posts\/([^/]+)\/voters$/;

export type FeaturebaseFake = {
  url: string;
  env: { FEATUREBASE_API_URL: string };
  /** What it serves; change it freely. */
  fixtures: FeaturebaseFixtures;
  /** A page holds at most this many (Featurebase: 100), so a few fixtures make several pages. */
  pageSize: number;
  /** Requests made, as `GET /v2/contacts?limit=100&…`. */
  requests: string[];
  /** Lists answered 403 with their items (e.g. "/v2/contacts"; posts' voters as "/v2/posts/voters"), as for a key that can't read them. */
  forbidden: Set<string>;
  /**
   * The next `times` API requests answer `status` (e.g. 429, 500), with these response headers (Retry-After,
   * X-RateLimit-Reset) and `body` as it is (default an error's JSON): a 200 with a cut-off body, an empty page.
   */
  failNext(status: number, times?: number, headers?: Record<string, string>, body?: string): void;
  /** Runs between a failing answer's headers and its body (sent a moment later): time passing as the body is read. */
  beforeBody?: () => void;
  /** Lets the slow key's held pages answer (FAKE_FEATUREBASE_SLOW_KEY), and those that come later too. */
  release(): void;
  /** Serves a file at `<url>/files/<name>` (no key, like Featurebase's attachments' links); returns its address. */
  file(name: string, type: string, body: Buffer): string;
  close(): Promise<void>;
};

/** A local stand-in for Featurebase's API (v2): it checks the key and serves fixtures, paged with opaque cursors. */
export async function startFeaturebaseFake(): Promise<FeaturebaseFake> {
  const files = new Map<string, { type: string; body: Buffer }>([
    ["whiteboard.png", { type: "image/png", body: PNG }],
    ["mira.png", { type: "image/png", body: PNG }],
  ]);
  let failing: { status: number; times: number; headers: Record<string, string>; body?: string } | undefined;
  /** The slow key's held pages, each with its fallback timer. */
  const held = new Map<() => void, NodeJS.Timeout>();
  /** Once released, the slow key's pages answer at once: one that arrives after the release isn't held. */
  let released = false;

  const server = createServer((req, res) => {
    const send = (status: number, body: unknown) =>
      res.writeHead(status, { "Content-Type": "application/json" }).end(JSON.stringify(body).replaceAll(FAKE_FEATUREBASE_FILES, `${fake.url}/files/`));
    const url = new URL(req.url ?? "/", "http://fake");
    if (req.method === "GET" && url.pathname.startsWith("/files/")) {
      const file = files.get(decodeURIComponent(url.pathname.slice("/files/".length)));
      return file ? res.writeHead(200, { "Content-Type": file.type }).end(file.body) : send(404, { message: "no such file" });
    }
    if (req.method === "POST" && url.pathname === "/_fake/release") {
      fake.release();
      return send(200, { released: true });
    }
    fake.requests.push(`${req.method} ${url.pathname}${url.search}`);
    const slow = req.headers.authorization === `Bearer ${FAKE_FEATUREBASE_SLOW_KEY}`;
    if (req.headers.authorization !== `Bearer ${FAKE_FEATUREBASE_KEY}` && !slow) {
      return send(401, { success: false, message: "Invalid API key" });
    }
    if (slow && !released && url.searchParams.get("limit") === "100" && !req.headers["x-fake-late"]) {
      req.headers["x-fake-late"] = "1";
      fake.requests.pop();
      const go = () => server.emit("request", req, res);
      const timer = setTimeout(() => held.delete(go) && go(), 60_000);
      held.set(go, timer);
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
    const voters = VOTERS.exec(url.pathname);
    const list = voters ? { rows: fake.fixtures.voters[decodeURIComponent(voters[1]!)] ?? [], paged: true } : LISTS[url.pathname] && { ...LISTS[url.pathname]!, rows: fake.fixtures[LISTS[url.pathname]!.fixtures] };
    const parent = url.pathname.slice(0, url.pathname.lastIndexOf("/"));
    const path = voters ? "/v2/posts/voters" : list ? url.pathname : parent;
    if (fake.forbidden.has(path)) {
      return send(403, { error: { type: "authorization_error", message: "Your API key can't read this", status: 403 } });
    }
    if (list) {
      const { rows } = list;
      if (!list.paged) {
        return send(200, "bare" in list ? rows : { object: "list", data: rows, nextCursor: null });
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
    release: () => {
      released = true;
      for (const [go, timer] of held) {
        clearTimeout(timer);
        held.delete(go);
        go();
      }
    },
    file: (name, type, body) => {
      files.set(name, { type, body });
      return `${url}/files/${encodeURIComponent(name)}`;
    },
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
  return fake;
}
