import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

/** The API key the fake accepts; any other is refused as Canny refuses one (400, "invalid api key"). */
export const FAKE_CANNY_KEY = "fake_canny_key";

type Row = Record<string, unknown>;

/** What the fake serves, made up; change it freely. `votes` by post id; lists in the order Canny keeps them. */
export type CannyFixtures = { users: Row[]; boards: Row[]; posts: Row[]; votes: Record<string, Row[]>; comments: Row[]; entries: Row[] };

/** Where the fixtures' images are: written into what the fake sends as its own `<url>/files/`. */
const FILES = "https://files.canny-fake.invalid/";
/** A small green PNG (96×64). */
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAGAAAABACAIAAABqVuVZAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAaUlEQVR42u3QMQ0AAAgDsInDE55QiQNujiZV0NQ0hygQJEiQIEGCBAlCkCBBggQJEiQIQYIECRIkSJAgBAkSJEiQIEGCBCFIkCBBggQJEoQgQYIECRIkSBCCBAkSJEiQIEGCECRIkKB/Flv/efAam8K1AAAAAElFTkSuQmCC",
  "base64",
);

const user = (id: string, name: string, email: string | null, rest: Row = {}) => ({ id, name, email, isAdmin: false, userID: null, avatarURL: null, customFields: {}, companies: [], created: "2023-01-01T00:00:00.000Z", ...rest });
const MIRA = user("c0000000000000000000u001", "Mira Fenwick", "e2e-canny-mira@example.com", { userID: "app-mira", customFields: { plan: "Pro" }, companies: [{ id: "co1", name: "Acme Labs" }], avatarURL: `${FILES}mira.png` });
const TOBIAS = user("c0000000000000000000u002", "Tobias Quill", "e2e-canny-tobias@example.com");
const JUNO = user("c0000000000000000000u003", "Juno Park", null);
const OLIVE = user("c0000000000000000000a001", "Olive Owner", "e2e-canny-olive@example.com", { isAdmin: true });
const BOARD = { id: "c0000000000000000000b001", name: "Feature Requests", isPrivate: false };
const PRIVATE_BOARD = { id: "c0000000000000000000b002", name: "Internal", isPrivate: true };

const post = (id: string, title: string, board: Row, author: Row | null, created: string, rest: Row = {}) => ({
  id,
  title,
  details: "",
  imageURLs: [],
  board,
  author,
  status: "open",
  statusChangedAt: null,
  eta: null,
  created,
  ...rest,
});
const comment = (id: string, postId: string, author: Row, value: string, created: string, rest: Row = {}) => ({
  id,
  value,
  imageURLs: [],
  post: { id: postId },
  author,
  internal: false,
  private: false,
  created,
  ...rest,
});
const entry = (id: string, title: string, markdownDetails: string, rest: Row = {}) => ({ id, title, markdownDetails, status: "published", types: [], posts: [], labels: [], scheduledFor: null, ...rest });

/**
 * Made-up Canny data: three users (one signed in through the team's app, with a company and custom field; two without)
 * and an admin; a public and a private board; posts oldest first with Canny's statuses, an ETA, images, the admin's,
 * one whose author was deleted, one on the private board; their votes; comments newest first (one with an image, the
 * team's internal one, a user's private one, one on the private board's post); and the changelog, newest first: an
 * entry linked to a post, with an image, one with two types, and a draft.
 */
export function cannyFixtures(): CannyFixtures {
  return {
    users: [MIRA, TOBIAS, JUNO, OLIVE],
    boards: [BOARD, PRIVATE_BOARD],
    posts: [
      post("c0000000000000000000p001", "Dark mode", BOARD, MIRA, "2024-01-10T08:00:00.000Z", {
        details: "Night owls need it.\n\nEspecially <on> phones.",
        imageURLs: [`${FILES}shot.png`],
        status: "complete",
        statusChangedAt: "2024-03-01T09:00:00.000Z",
        eta: "June 2024",
      }),
      post("c0000000000000000000p002", "CSV export", BOARD, TOBIAS, "2024-02-01T10:00:00.000Z", { status: "under review" }),
      post("c0000000000000000000p003", "Quarterly planning", BOARD, OLIVE, "2024-02-02T10:00:00.000Z", { status: "planned" }),
      post("c0000000000000000000p004", "Secret plan", PRIVATE_BOARD, OLIVE, "2024-02-03T10:00:00.000Z"),
      post("c0000000000000000000p005", "Keyboard shortcuts", BOARD, null, "2024-02-04T10:00:00.000Z", { status: "Beta" }),
    ],
    votes: {
      "c0000000000000000000p001": [
        { voter: JUNO, created: "2024-01-20T00:00:00.000Z" },
        { voter: TOBIAS, created: "2024-01-15T00:00:00.000Z" },
        { voter: MIRA, created: "2024-01-10T08:00:00.000Z" },
      ],
      "c0000000000000000000p002": [
        { voter: OLIVE, created: "2024-02-05T00:00:00.000Z" },
        { voter: TOBIAS, created: "2024-02-01T10:00:00.000Z" },
      ],
    },
    comments: [
      comment("c0000000000000000000c005", "c0000000000000000000p004", TOBIAS, "On a private board", "2024-02-05T09:00:00.000Z"),
      comment("c0000000000000000000c004", "c0000000000000000000p002", OLIVE, "On our list, thanks!", "2024-02-03T09:00:00.000Z"),
      comment("c0000000000000000000c003", "c0000000000000000000p001", MIRA, "Just between us: we'd pay for it.", "2024-01-13T09:00:00.000Z", { private: true }),
      comment("c0000000000000000000c002", "c0000000000000000000p001", OLIVE, "Planning it for June.", "2024-01-12T09:00:00.000Z", { internal: true }),
      comment("c0000000000000000000c001", "c0000000000000000000p001", TOBIAS, "Yes please!", "2024-01-11T09:00:00.000Z", { imageURLs: [`${FILES}whiteboard.png`] }),
    ],
    entries: [
      entry("c0000000000000000000e003", "Single sign-on", "Coming soon.", { status: "draft", publishedAt: null, created: "2024-03-15T09:00:00.000Z" }),
      entry("c0000000000000000000e002", "Faster exports", "Exports take **half** the time.", { types: ["improved", "fixed"], publishedAt: "2024-03-10T09:00:00.000Z", created: "2024-03-09T09:00:00.000Z" }),
      entry("c0000000000000000000e001", "Dark mode is here", `Easy on the eyes at night.\n\n![Dark mode](${FILES}welcome.png)`, {
        types: ["new"],
        posts: [{ id: "c0000000000000000000p001" }],
        publishedAt: "2024-03-01T09:00:00.000Z",
        created: "2024-02-28T09:00:00.000Z",
      }),
    ],
  };
}

export type CannyFake = {
  url: string;
  env: { CANNY_API_URL: string };
  fixtures: CannyFixtures;
  /** A page holds at most this many (Canny: 100), so a few fixtures make several pages. */
  pageSize: number;
  /** Requests made, as `POST /v1/posts/list {"skip":0,…}` (without the key). */
  requests: string[];
  close(): Promise<void>;
};

/** A local stand-in for Canny's API: it checks the key and serves fixtures, paged by skip or cursor as Canny pages each list. */
export async function startCannyFake(): Promise<CannyFake> {
  const files = new Map([
    ["mira.png", PNG],
    ["shot.png", PNG],
    ["whiteboard.png", PNG],
    ["welcome.png", PNG],
  ]);
  const server = createServer((req, res) => {
    const send = (status: number, body: unknown) => res.writeHead(status, { "Content-Type": "application/json" }).end(JSON.stringify(body).replaceAll(FILES, `${fake.url}/files/`));
    const path = new URL(req.url ?? "/", "http://fake").pathname;
    if (req.method === "GET" && path.startsWith("/files/")) {
      const file = files.get(path.slice("/files/".length));
      return file ? res.writeHead(200, { "Content-Type": "image/png" }).end(file) : send(404, { error: "not found" });
    }
    let text = "";
    req.on("data", (chunk: Buffer) => (text += chunk));
    req.on("end", () => {
      const { apiKey, ...body } = JSON.parse(text || "{}") as Row;
      fake.requests.push(`${req.method} ${path} ${JSON.stringify(body)}`);
      if (apiKey !== FAKE_CANNY_KEY) {
        return send(400, { error: "invalid api key" });
      }
      const limit = Math.min(Number(body.limit ?? 10), fake.pageSize);
      const skipped = <T>(rows: T[]) => {
        const skip = Number(body.skip ?? 0);
        return { items: rows.slice(skip, skip + limit), hasMore: skip + limit < rows.length };
      };
      const cursored = <T>(rows: T[]) => {
        const start = body.cursor ? Number(Buffer.from(String(body.cursor), "base64url").toString()) : 0;
        const end = start + limit;
        return { items: rows.slice(start, end), hasNextPage: end < rows.length, cursor: end < rows.length ? Buffer.from(String(end)).toString("base64url") : null };
      };
      const { fixtures } = fake;
      switch (path) {
        case "/v1/boards/list":
          return send(200, { boards: fixtures.boards });
        case "/v1/posts/list": {
          // Oldest first only when asked; Canny's default is newest.
          const { items, hasMore } = skipped(body.sort === "oldest" ? fixtures.posts : [...fixtures.posts].reverse());
          return send(200, { posts: items, hasMore });
        }
        case "/v2/users/list": {
          const { items, ...rest } = cursored(fixtures.users);
          return send(200, { users: items, ...rest });
        }
        case "/v1/users/retrieve": {
          const found = fixtures.users.find((row) => row.id === body.id);
          return found ? send(200, found) : send(400, { error: "invalid user id" });
        }
        case "/v2/votes/list":
          if (!fixtures.posts.some((row) => row.id === body.postID)) {
            return send(400, { error: "invalid post id" });
          }
          return send(200, cursored(fixtures.votes[String(body.postID)] ?? []));
        case "/v2/comments/list":
          return send(200, cursored(fixtures.comments));
        case "/v1/entries/list": {
          // Newest first (`sort: created`), up to 10,000 at once as Canny takes (the page size doesn't apply).
          const skip = Number(body.skip ?? 0);
          const end = skip + Math.min(Number(body.limit ?? 10), 10_000);
          return send(200, { entries: fixtures.entries.slice(skip, end), hasMore: end < fixtures.entries.length });
        }
      }
      return send(404, { error: `the fake doesn't serve ${path}` });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const fake: CannyFake = {
    url,
    env: { CANNY_API_URL: url },
    fixtures: cannyFixtures(),
    pageSize: 100,
    requests: [],
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
  return fake;
}
