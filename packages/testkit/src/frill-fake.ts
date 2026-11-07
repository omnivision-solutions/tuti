import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

/** The API key the fake accepts (as a Bearer token); any other is refused as Frill refuses one (401). */
export const FAKE_FRILL_KEY = "fake_frill_key";

type Row = Record<string, unknown>;

/** What the fake serves, made up; change it freely. `votes` and `comments` by idea idx; lists in the order Frill keeps them. */
export type FrillFixtures = { followers: Row[]; ideas: Row[]; votes: Record<string, Row[]>; comments: Record<string, Row[]>; announcements: Row[] };

/** Where the fixtures' images are: written into what the fake sends as its own `<url>/files/`. */
const FILES = "https://files.frill-fake.invalid/";
/** A small green PNG (96×64). */
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAGAAAABACAIAAABqVuVZAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAaUlEQVR42u3QMQ0AAAgDsInDE55QiQNujiZV0NQ0hygQJEiQIEGCBAlCkCBBggQJEiQIQYIECRIkSJAgBAkSJEiQIEGCBCFIkCBBggQJEoQgQYIECRIkSBCCBAkSJEiQIEGCECRIkKB/Flv/efAam8K1AAAAAElFTkSuQmCC",
  "base64",
);

const follower = (idx: string, name: string, email: string | null, rest: Row = {}) => ({ idx, name, email, avatar: null, created_at: "2023-01-01T00:00:00.000Z", ...rest });
const MIRA = follower("follower_mira", "Mira Fenwick", "e2e-frill-mira@example.com", { avatar: `${FILES}mira.png` });
const TOBIAS = follower("follower_tobias", "Tobias Quill", "e2e-frill-tobias@example.com");
const JUNO = follower("follower_juno", "Juno Park", null);
/** A teammate: Frill names them on what they wrote, and its followers' list doesn't have them. */
const TARA = { idx: "user_tara", name: "Tara Teammate", avatar: null };
const person = ({ idx, name, avatar }: Row) => ({ idx, name, avatar });

const status = (name: string) => ({ idx: `status_${name.toLowerCase().replace(/\W+/g, "_")}`, name, color: "#6392D9" });
const idea = (idx: string, name: string, author: Row | null, created_at: string, rest: Row = {}) => ({
  idx,
  name,
  slug: idx,
  description: "",
  content_html: "",
  vote_count: 0,
  comment_count: 0,
  note_count: 0,
  is_pinned: false,
  is_bug: false,
  is_archived: false,
  is_completed: false,
  show_in_roadmap: true,
  approval_status: "approved",
  created_at,
  updated_at: created_at,
  author: author && person(author),
  status: null,
  topics: [],
  attachments: [],
  ...rest,
});
const comment = (idx: string, author: Row, message: string, created_at: string, rest: Row = {}) => ({
  idx,
  message,
  content_html: `<p>${message}</p>`,
  is_private: false,
  type: "comment",
  created_at,
  updated_at: created_at,
  follower: person(author),
  idea_id: 1,
  attachments: [],
  ...rest,
});
const announcement = (idx: string, name: string, content_html: string, rest: Row = {}) => ({ idx, name, slug: idx, content: "", content_html, is_published: true, categories: [], ideas: [], ...rest });
const image = (name: string) => ({ idx: `attachment_${name}`, name, url: `${FILES}${name}`, type: "image/png" });

/**
 * Made-up Frill data: three followers (one without an address) and a teammate who isn't one; ideas oldest first with
 * the team's statuses, an image attached, the teammate's, a private one, a bug, one waiting for approval, an archived
 * one and one whose author is gone; their votes; comments by idea (one with an image, the team's note, one on the
 * archived idea); and announcements, newest first: one linked to an idea, with an image, one with two categories, and
 * a draft.
 */
export function frillFixtures(): FrillFixtures {
  return {
    followers: [MIRA, TOBIAS, JUNO],
    ideas: [
      idea("idea_dark", "Dark mode", MIRA, "2024-01-10T08:00:00.000Z", {
        content_html: "<p>Night owls need it.</p><p>Especially &lt;on&gt; phones.</p>",
        attachments: [image("shot.png")],
        status: status("Shipped"),
        is_completed: true,
        comment_count: 1,
        note_count: 1,
      }),
      idea("idea_csv", "CSV export", TOBIAS, "2024-02-01T10:00:00.000Z", { status: status("Under Consideration"), comment_count: 1 }),
      idea("idea_planning", "Quarterly planning", TARA, "2024-02-02T10:00:00.000Z", { status: status("Planned") }),
      idea("idea_secret", "Secret plan", TOBIAS, "2024-02-03T10:00:00.000Z", { is_private: true }),
      idea("idea_crash", "Crash on login", JUNO, "2024-02-03T11:00:00.000Z", { is_bug: true, status: status("In Development") }),
      idea("idea_pending", "Pending idea", JUNO, "2024-02-03T12:00:00.000Z", { approval_status: "needs-approval" }),
      idea("idea_old", "Old idea", MIRA, "2024-02-03T13:00:00.000Z", { is_archived: true, comment_count: 1 }),
      idea("idea_keys", "Keyboard shortcuts", null, "2024-02-04T10:00:00.000Z", { status: status("Beta") }),
    ],
    votes: {
      idea_dark: [
        { idx: "vote_1", voter: person(JUNO), created_at: "2024-01-20T00:00:00.000Z" },
        { idx: "vote_2", voter: person(TOBIAS), created_at: "2024-01-15T00:00:00.000Z" },
        { idx: "vote_3", voter: person(MIRA), created_at: "2024-01-10T08:00:00.000Z" },
      ],
      idea_csv: [
        { idx: "vote_4", voter: person(MIRA), created_at: "2024-02-05T00:00:00.000Z" },
        { idx: "vote_5", voter: person(TOBIAS), created_at: "2024-02-01T10:00:00.000Z" },
      ],
    },
    comments: {
      // Newest first.
      idea_dark: [
        comment("comment_note", TARA, "Planning it for June.", "2024-01-12T09:00:00.000Z", { is_private: true, type: "note" }),
        comment("comment_yes", TOBIAS, "Yes please!", "2024-01-11T09:00:00.000Z", { attachments: [image("whiteboard.png")] }),
      ],
      idea_csv: [comment("comment_list", TARA, "On our list, thanks!", "2024-02-03T09:00:00.000Z")],
      idea_old: [comment("comment_old", TOBIAS, "On an archived idea", "2024-02-05T09:00:00.000Z")],
    },
    announcements: [
      announcement("announcement_sso", "Single sign-on", "<p>Coming soon.</p>", { is_published: false, published_at: null, created_at: "2024-03-15T09:00:00.000Z" }),
      announcement("announcement_exports", "Faster exports", "<p>Exports take <strong>half</strong> the time.</p>", {
        categories: [
          { idx: "category_improvement", name: "Improvement", color: "#00f" },
          { idx: "category_fix", name: "Fix", color: "#f00" },
        ],
        published_at: "2024-03-10T09:00:00.000Z",
        created_at: "2024-03-09T09:00:00.000Z",
      }),
      announcement("announcement_dark", "Dark mode is here", `<p>Easy on the eyes at night.</p><p><img src="${FILES}welcome.png" alt="Dark mode"></p>`, {
        categories: [{ idx: "category_new", name: "New", color: "#0f0" }],
        ideas: [{ idx: "idea_dark", name: "Dark mode" }],
        published_at: "2024-03-01T09:00:00.000Z",
        created_at: "2024-02-28T09:00:00.000Z",
      }),
    ],
  };
}

export type FrillFake = {
  url: string;
  env: { FRILL_API_URL: string };
  fixtures: FrillFixtures;
  /** A page holds at most this many (Frill: 100), so a few fixtures make several pages. */
  pageSize: number;
  /** Requests made, as `GET /v1/ideas?limit=100&sort=ASC`. */
  requests: string[];
  /** The next `times` requests answer `status` (429, 500, …) with these headers (Retry-After), `{"error":true,"message":"fake failure"}`. */
  failNext(status: number, times?: number, headers?: Record<string, string>): void;
  close(): Promise<void>;
};

/** A local stand-in for Frill's API: it checks the key and serves fixtures, paged by cursor (`after`) as Frill pages its lists. */
export async function startFrillFake(): Promise<FrillFake> {
  const files = new Map([
    ["mira.png", PNG],
    ["shot.png", PNG],
    ["whiteboard.png", PNG],
    ["welcome.png", PNG],
  ]);
  let failing: { status: number; times: number; headers: Record<string, string> } | undefined;
  const server = createServer((req, res) => {
    const send = (code: number, body: unknown) => res.writeHead(code, { "Content-Type": "application/json" }).end(JSON.stringify(body).replaceAll(FILES, `${fake.url}/files/`));
    const url = new URL(req.url ?? "/", "http://fake");
    const path = url.pathname;
    if (path.startsWith("/files/")) {
      const file = files.get(path.slice("/files/".length));
      return file ? res.writeHead(200, { "Content-Type": "image/png" }).end(file) : send(404, { error: true, message: "not found" });
    }
    fake.requests.push(`${req.method} ${path}${url.search}`);
    if (failing) {
      const { status: code, headers } = failing;
      failing = --failing.times > 0 ? failing : undefined;
      return res.writeHead(code, { "Content-Type": "application/json", ...headers }).end(JSON.stringify({ error: true, message: "fake failure" }));
    }
    if (req.headers.authorization !== `Bearer ${FAKE_FRILL_KEY}`) {
      return send(401, { error: true, message: "Unauthenticated." });
    }
    const query = url.searchParams;
    const paged = (rows: Row[]) => {
      const limit = Math.min(Number(query.get("limit") ?? 20), 100, fake.pageSize);
      const after = query.get("after");
      const start = after ? Number(Buffer.from(after, "base64url").toString()) : 0;
      const end = start + limit;
      const data = rows.slice(start, end);
      const cursor = (n: number) => Buffer.from(String(n)).toString("base64url");
      return send(200, { data, meta: {}, pagination: { total: rows.length, count: data.length, hasNextPage: end < rows.length, startCursor: cursor(start), endCursor: cursor(Math.min(end, rows.length)) } });
    };
    const { fixtures } = fake;
    const known = (idx: string | null) => fixtures.ideas.some((row) => row.idx === idx);
    switch (path) {
      case "/v1/statuses":
        return paged([]);
      case "/v1/followers":
        return paged(fixtures.followers);
      case "/v1/ideas":
        // Newest first unless asked otherwise, as Frill's default.
        return paged(query.get("sort") === "ASC" ? fixtures.ideas : [...fixtures.ideas].reverse());
      case "/v1/votes":
        return known(query.get("idea_idx")) ? paged(fixtures.votes[query.get("idea_idx")!] ?? []) : send(400, { error: true, message: "Invalid idea_idx" });
      case "/v1/comments": {
        const idea = query.get("idea_idx");
        if (!known(idea)) {
          return send(404, { error: true, message: "Idea not found" });
        }
        // Comments only, unless notes are asked for too (Frill's default).
        const types = (query.get("included_types") ?? "comments").split(/[|,]/);
        return paged((fixtures.comments[idea!] ?? []).filter((row) => types.includes(row.is_private ? "notes" : "comments")));
      }
      case "/v1/announcements":
        return paged(fixtures.announcements);
    }
    return send(404, { error: true, message: `the fake doesn't serve ${path}` });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const fake: FrillFake = {
    url,
    env: { FRILL_API_URL: `${url}/v1` },
    fixtures: frillFixtures(),
    pageSize: 100,
    requests: [],
    failNext: (code, times = 1, headers = {}) => void (failing = { status: code, times, headers }),
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
  return fake;
}
