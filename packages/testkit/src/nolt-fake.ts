import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

/** The API key the fake accepts; any other gets the 500 Nolt answers a key it doesn't know with. */
export const FAKE_NOLT_KEY = "fake_nolt_key";

type Row = Record<string, unknown>;

/** What the fake serves, made up; change it freely. Posts oldest first, each with its comments (oldest first) and votes. */
export type NoltFixtures = { board: Row; users: Row[]; statuses: Row[]; posts: (Row & { id: string; comments: Row[]; votes: Row[] })[] };

/** Where the fixtures' images are: written into what the fake sends as its own `<url>/files/`. */
const FILES = "https://files.nolt-fake.invalid/";
/** A small green PNG (96×64). */
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAGAAAABACAIAAABqVuVZAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAaUlEQVR42u3QMQ0AAAgDsInDE55QiQNujiZV0NQ0hygQJEiQIEGCBAlCkCBBggQJEiQIQYIECRIkSJAgBAkSJEiQIEGCBCFIkCBBggQJEoQgQYIECRIkSBCCBAkSJEiQIEGCECRIkKB/Flv/efAam8K1AAAAAElFTkSuQmCC",
  "base64",
);

const MIRA = { ssoId: "app-mira", name: "Mira Fenwick", email: "e2e-nolt-mira@example.com", image: `${FILES}mira.png` };
const TOBIAS = { ssoId: null, name: "Tobias Quill", email: "e2e-nolt-tobias@example.com", image: null };
const OLIVE = { ssoId: null, name: "Olive Owner", email: "e2e-nolt-olive@example.com", image: null };
/** Neither an id nor an address: someone of their own. */
const JUNO = { ssoId: null, name: "Juno Park", email: null, image: null };

const comment = (id: string, user: Row | null, text: string, dateCreated: string, rest: Row = {}) => ({ id, text, type: "BASIC", dateCreated, moderationStatus: "APPROVED", files: [], user, ...rest });
const post = (id: string, title: string, dateCreated: string, comments: Row[], rest: Row = {}) => ({ id, title, statusId: "OPEN", dateCreated, dateCompleted: null, moderationStatus: "APPROVED", comments, votes: [] as Row[], ...rest });
const up = (user: Row | null) => ({ type: "UP", user });

/**
 * Made-up Nolt data: users (one signed in through the team's app, two with an address only, one with neither), the
 * team's own statuses, and posts oldest first, each made with its first comment (the post's text): one completed with
 * images, a status change Nolt wrote and the team's reply; one under review with a comment waiting for moderation; one
 * waiting for moderation; one by someone with no id or address, in a status of the team's own; one rejected; one planned.
 */
export function noltFixtures(): NoltFixtures {
  return {
    board: { id: "nb1", name: "Acme Feedback" },
    users: [MIRA, TOBIAS, OLIVE, JUNO],
    statuses: [
      { id: "s-review", name: "Under review", type: "CUSTOM" },
      { id: "s-planned", name: "Planned", type: "CUSTOM" },
      { id: "s-beta", name: "Beta", type: "CUSTOM" },
      // Nolt's own, listed by their type (a post may also carry a system value as its statusId: "COMPLETED").
      { id: "s-shipped", name: "Shipped", type: "COMPLETED" },
      { id: "s-archived", name: "Archived", type: "ARCHIVED" },
      { id: "s-merged", name: "Merged", type: "MERGED" },
      { id: "s-open", name: "Inbox", type: "UNASSIGNED" },
    ],
    posts: [
      post(
        "np1",
        "Dark mode",
        "2024-01-10T08:00:00.000Z",
        [
          comment("nc1", MIRA, "Night owls need it.\n\nEspecially <on> phones.", "2024-01-10T08:00:00.000Z", { files: [{ url: `${FILES}shot.png` }] }),
          comment("nc2", TOBIAS, "Yes please!", "2024-01-11T09:00:00.000Z", { files: [{ url: `${FILES}whiteboard.png` }] }),
          comment("nc3", OLIVE, "Planning it for June.", "2024-01-12T09:00:00.000Z"),
          comment("nc4", OLIVE, "Completed", "2024-03-01T09:00:00.000Z", { type: "STATUS_CHANGE" }),
        ],
        // A downvote, one by someone with neither id nor address, and one whose voter Nolt no longer has aren't brought.
        { statusId: "COMPLETED", dateCompleted: "2024-03-01T09:00:00.000Z", votes: [up(MIRA), up(TOBIAS), { type: "DOWN", user: OLIVE }, up(JUNO), up(null)] },
      ),
      post(
        "np2",
        "CSV export",
        "2024-02-01T10:00:00.000Z",
        [
          comment("nc5", TOBIAS, "For our accountants.", "2024-02-01T10:00:00.000Z"),
          comment("nc6", OLIVE, "On our list, thanks!", "2024-02-03T09:00:00.000Z"),
          comment("nc7", MIRA, "Buy cheap followers", "2024-02-04T09:00:00.000Z", { moderationStatus: "PENDING" }),
        ],
        { statusId: "s-review", votes: [up(TOBIAS), up(OLIVE)] },
      ),
      post("np3", "Waiting post", "2024-02-02T10:00:00.000Z", [comment("nc8", TOBIAS, "Not approved yet.", "2024-02-02T10:00:00.000Z")], { moderationStatus: "PENDING" }),
      post("np4", "Keyboard shortcuts", "2024-02-04T10:00:00.000Z", [comment("nc9", JUNO, "Vim keys.", "2024-02-04T10:00:00.000Z")], { statusId: "s-beta" }),
      post("np5", "Rejected post", "2024-02-05T10:00:00.000Z", [comment("nc10", TOBIAS, "Off topic.", "2024-02-05T10:00:00.000Z")], { moderationStatus: "REJECTED" }),
      post("np6", "Quarterly planning", "2024-02-06T10:00:00.000Z", [comment("nc11", OLIVE, "For the roadmap.", "2024-02-06T10:00:00.000Z")], { statusId: "s-planned" }),
    ],
  };
}

export type NoltFake = {
  url: string;
  /** NOLT_REQUEST_INTERVAL_MS: no pause between requests. */
  env: { NOLT_API_URL: string; NOLT_REQUEST_INTERVAL_MS: string };
  fixtures: NoltFixtures;
  /** A page (and a post's first chunk of comments) holds at most this many, so a few fixtures make several pages. */
  pageSize: number;
  /** Posts still listed but deleted since: asking for one by its id answers "Post not found". */
  gone: Set<string>;
  /** Requests made, as `NoltPosts {"cursor":null}`. */
  requests: string[];
  /** The next `times` requests answer `status` (429, 500, …) with these headers (Retry-After), a GraphQL error. */
  failNext(status: number, times?: number, headers?: Record<string, string>): void;
  close(): Promise<void>;
};

/** A local stand-in for Nolt's GraphQL API: it checks the key and answers the import's queries by their names. */
export async function startNoltFake(): Promise<NoltFake> {
  const files = new Map([
    ["mira.png", PNG],
    ["shot.png", PNG],
    ["whiteboard.png", PNG],
  ]);
  let failing: { status: number; times: number; headers: Record<string, string> } | undefined;
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
      const { operationName, variables = {} } = JSON.parse(text || "{}") as { operationName?: string; variables?: Row };
      fake.requests.push(`${operationName} ${JSON.stringify(variables)}`);
      if (failing) {
        const { status, headers } = failing;
        failing = --failing.times > 0 ? failing : undefined;
        return res.writeHead(status, { "Content-Type": "application/json", ...headers }).end(JSON.stringify({ errors: [{ message: "fake failure" }] }));
      }
      if (req.headers.apikey !== FAKE_NOLT_KEY) {
        // As Nolt answers a key it doesn't know: its own code failing.
        return send(500, { errors: [{ message: "Cannot read properties of undefined (reading 'find')", extensions: { code: "INTERNAL_SERVER_ERROR" } }] });
      }
      const paged = <T>(rows: T[], cursor: unknown) => {
        const start = cursor ? Number(Buffer.from(String(cursor), "base64url").toString()) : 0;
        const end = start + fake.pageSize;
        return { nodes: rows.slice(start, end), hasMore: end < rows.length, cursor: end < rows.length ? Buffer.from(String(end)).toString("base64url") : null };
      };
      const { fixtures } = fake;
      const found = fake.gone.has(String(variables.id)) ? undefined : fixtures.posts.find((row) => row.id === variables.id);
      const listed = ({ comments, votes: _, ...row }: NoltFixtures["posts"][number]) => ({ ...row, comments: paged(comments, null) });
      const missing = () => send(200, { data: { post: null }, errors: [{ message: "Post not found", path: ["post"] }] });
      switch (operationName) {
        case "NoltBoard":
          return send(200, { data: { board: fixtures.board } });
        case "NoltUsers":
          return send(200, { data: { users: fixtures.users } });
        case "NoltStatuses":
          return send(200, { data: { listStatuses: fixtures.statuses.map((status) => ({ color: "#888", ...status })) } });
        case "NoltPosts": {
          // Newest first: Nolt sorts by trending, top, newest or completion, never oldest.
          const { nodes, ...rest } = paged([...fixtures.posts].reverse(), variables.cursor);
          return send(200, { data: { posts: { nodes: nodes.map(listed), ...rest } } });
        }
        case "NoltComments":
          return found ? send(200, { data: { post: { comments: paged(found.comments, variables.cursor) } } }) : missing();
        case "NoltVotes":
          return found ? send(200, { data: { post: { votes: paged(found.votes, variables.cursor) } } }) : missing();
      }
      return send(400, { errors: [{ message: `the fake doesn't answer ${operationName}`, extensions: { code: "GRAPHQL_VALIDATION_FAILED" } }] });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const fake: NoltFake = {
    url,
    env: { NOLT_API_URL: `${url}/api/v1/graphql`, NOLT_REQUEST_INTERVAL_MS: "0" },
    fixtures: noltFixtures(),
    pageSize: 50,
    gone: new Set(),
    requests: [],
    failNext: (status, times = 1, headers = {}) => void (failing = { status, times, headers }),
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
  return fake;
}
