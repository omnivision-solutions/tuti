import { afterEach, describe, expect, it, vi } from "vitest";

import { type Api, ApiError } from "./api";
import {
  CLOSE_LEFT,
  type Fetched,
  withoutSent,
  typed,
  queueUnsent,
  EDIT_FIRST,
  canEdit,
  unsentId,
  FIRST_SENT,
  afterFetch,
  afterSend,
  attach,
  clearUploadFailure,
  composerInset,
  type Conversation,
  delivery,
  draftsGoWith,
  draftsGeneration,
  draftWithAi,
  editUnsent,
  EMPTY_DRAFT,
  FILES_LAST_MS,
  forgetDrafts,
  ID_CLASH,
  getUploadFailure,
  getUploading,
  getDraft,
  isSending,
  linkParts,
  markReadIfLooking,
  type Message,
  parseEvents,
  readDraft,
  runsOn,
  sendReply,
  sendUnsent,
  subscribeDraft,
  type Unsent,
  updateDraft,
  upload,
  watchLive,
  withDraft,
  writeDraft,
  writer,
} from "./conversation";

// The phone's files, in memory: a path per file.
const files = vi.hoisted(() => ({ stored: new Map<string, string>(), uploads: [] as { from: string; url: string; options: unknown }[], uploadStatus: 200 }));
vi.mock("expo-file-system", () => {
  const path = (parts: unknown[]) => parts.map((part) => (typeof part === "string" ? part : (part as { uri: string }).uri)).join("/");
  class File {
    uri: string;
    constructor(...parts: unknown[]) {
      this.uri = path(parts);
    }
    get exists() {
      return files.stored.has(this.uri);
    }
    get size() {
      return files.stored.get(this.uri)?.length ?? 0;
    }
    textSync() {
      return files.stored.get(this.uri)!;
    }
    writeSync(text: string) {
      files.stored.set(this.uri, text);
    }
    delete() {
      files.stored.delete(this.uri);
    }
    async upload(url: string, options: unknown) {
      files.uploads.push({ from: this.uri, url, options });
      return { status: files.uploadStatus, body: "", headers: {} };
    }
  }
  class Directory {
    uri: string;
    constructor(...parts: unknown[]) {
      this.uri = path(parts);
    }
    get exists() {
      return [...files.stored.keys()].some((key) => key.startsWith(`${this.uri}/`));
    }
    create() {}
    delete() {
      for (const key of [...files.stored.keys()].filter((key) => key.startsWith(`${this.uri}/`))) {
        files.stored.delete(key);
      }
    }
  }
  return { File, Directory, Paths: { document: { uri: "documents" } } };
});

afterEach(() => {
  forgetDrafts();
  files.stored.clear();
  files.uploads = [];
  files.uploadStatus = 200;
  vi.useRealTimers();
});

const message = (fields: Partial<Message>): Message => ({
  id: "m1",
  author: "user",
  name: null,
  body: "Hi",
  note: false,
  attachments: [],
  attachmentsDropped: 0,
  createdAt: "2026-11-25T09:00:00.000Z",
  fromYou: false,
  fromAddress: null,
  seenAt: null,
  emailStatus: null,
  emailError: null,
  ...fields,
});

/** A send's fetch that shows nothing new. */
const nothing = async (): Promise<Fetched> => ({ messages: [], status: "open" });

/** An API that answers each path with what `answers` gives, and records what it was asked. */
function fakeApi(answers: Record<string, () => unknown>) {
  const calls: { path: string; method?: string; body?: unknown }[] = [];
  const api = (async (path: string, init: { method?: string; body?: unknown } = {}) => {
    calls.push({ path, ...init });
    return answers[path]!();
  }) as Api;
  return { api, calls };
}

describe("a message", () => {
  it("says who wrote it: You for your own, a Cc'd sender by their address, the person otherwise", () => {
    expect(writer(message({ author: "team", name: "Olive", fromYou: true }), "Maya")).toBe("You");
    expect(writer(message({ author: "team", name: "Ravi" }), "Maya")).toBe("Ravi");
    expect(writer(message({ fromAddress: "e2e-boss@example.com" }), "Maya")).toBe("e2e-boss@example.com");
    expect(writer(message({}), "Maya")).toBe("Maya");
  });

  it("says Seen, or how its email went, under the team's reply only; a bounce is a problem, with why", () => {
    expect(delivery(message({ author: "team", seenAt: "2026-11-25T09:01:00.000Z", emailStatus: "delivered" }))).toEqual({ text: "Seen", problem: false });
    expect(delivery(message({ author: "team", emailStatus: "bounced", emailError: "Mailbox full" }))).toEqual({ text: "The email bounced: Mailbox full", problem: true });
    expect(delivery(message({ author: "team", emailStatus: "delivered" }))).toEqual({ text: "Emailed and delivered", problem: false });
    expect(delivery(message({ author: "team", note: true, emailStatus: "sent" }))).toBeNull();
    expect(delivery(message({ emailStatus: "sent" }))).toBeNull();
  });

  it("runs into the next from the same sender within minutes, never across a note", () => {
    const messages = [
      message({ id: "a", createdAt: "2026-11-25T09:00:00.000Z" }),
      message({ id: "b", createdAt: "2026-11-25T09:02:00.000Z" }),
      message({ id: "c", createdAt: "2026-11-25T09:30:00.000Z" }),
      message({ id: "d", author: "team", note: true, createdAt: "2026-11-25T09:31:00.000Z" }),
    ];
    expect([0, 1, 2, 3].map((index) => runsOn(messages, index, "Maya"))).toEqual([true, false, false, false]);
  });

  it("links its web addresses, not the full stop after one", () => {
    expect(linkParts("See https://acme.example.com/help. Thanks")).toEqual(["See ", "https://acme.example.com/help", ". Thanks"]);
    expect(linkParts("javascript:alert(1)")).toEqual(["javascript:alert(1)"]);
  });
});

describe("the draft kept on the phone", () => {
  const key = "https://tuti.example.com|acme|12";

  it("is read back as written, per conversation, and goes once empty", () => {
    const draft = { ...EMPTY_DRAFT, reply: "Thanks, Maya", unsent: [{ id: "u1", body: "Fixed", note: false, close: false, files: [], seen: null, error: "Couldn't reach tuti.example.com" }] };
    writeDraft(key, draft);
    expect(readDraft(key)).toEqual(draft);
    expect(readDraft("https://tuti.example.com|acme|13")).toEqual(EMPTY_DRAFT);
    writeDraft(key, EMPTY_DRAFT);
    expect(files.stored.size).toBe(0);
  });

  it("drops files uploaded too long ago to send", () => {
    const now = Date.parse("2026-11-25T09:00:00.000Z");
    const file = (id: string, at: number) => ({ id, name: `${id}.pdf`, contentType: "application/pdf", size: 10, at });
    writeDraft(key, { ...EMPTY_DRAFT, files: [file("old", now - FILES_LAST_MS), file("new", now - 60_000)] });
    expect(readDraft(key, now).files.map((kept) => kept.id)).toEqual(["new"]);
  });

  it("is gone after signing out, and a broken one reads as none", () => {
    writeDraft(key, { ...EMPTY_DRAFT, note: "Ravi is on it" });
    forgetDrafts();
    expect(readDraft(key)).toEqual(EMPTY_DRAFT);
    files.stored.set(`documents/drafts/${encodeURIComponent(key)}.json`, "{");
    expect(readDraft(key)).toEqual(EMPTY_DRAFT);
  });
});

describe("replying", () => {
  it("sends the reply with what it closes, what was seen, its files' ids and its own id as requestId", async () => {
    const { api, calls } = fakeApi({ "/conversations/12/messages": () => ({ id: "m9", closed: true }) });
    const files = [{ id: "up1", name: "a.png", contentType: "image/png", size: 5, at: 0 }];
    await sendReply(api, 12, { id: "u1", body: "Fixed now", note: false, close: true, files, seen: "2026-11-25T09:00:00.000Z" });
    await sendReply(api, 12, { id: "u2", body: "Ravi knows", note: true, close: false, files: [], seen: null });
    expect(calls).toEqual([
      { path: "/conversations/12/messages", method: "POST", body: { body: "Fixed now", close: true, seen: "2026-11-25T09:00:00.000Z", attachments: ["up1"], requestId: "u1" } },
      { path: "/conversations/12/messages", method: "POST", body: { body: "Ravi knows", note: true, requestId: "u2" } },
    ]);
  });

  it("uploads a file: started on the server, then PUT to its address with the type it signed", async () => {
    const { api, calls } = fakeApi({ "/inbox/uploads": () => ({ id: "up1", contentType: "application/pdf", uploadUrl: "https://media.example.com/up1?sig=x" }) });
    const attached = await upload(api, { uri: "file:///cache/invoice.pdf", name: "invoice.pdf", contentType: "application/pdf", size: 4800 }, 1000);
    expect(calls).toEqual([{ path: "/inbox/uploads", method: "POST", body: { filename: "invoice.pdf", contentType: "application/pdf", size: 4800 } }]);
    expect(files.uploads).toEqual([{ from: "file:///cache/invoice.pdf", url: "https://media.example.com/up1?sig=x", options: { httpMethod: "PUT", headers: { "content-type": "application/pdf" } } }]);
    expect(attached).toEqual({ id: "up1", name: "invoice.pdf", contentType: "application/pdf", size: 4800, at: 1000 });
  });

  it("takes the file's size from the file when the picker didn't say", async () => {
    files.stored.set("file:///cache/notes.txt", "twelve bytes");
    const { api, calls } = fakeApi({ "/inbox/uploads": () => ({ id: "up1", contentType: "text/plain", uploadUrl: "https://media.example.com/up1" }) });
    expect((await upload(api, { uri: "file:///cache/notes.txt", name: "notes.txt", contentType: "text/plain", size: 0 })).size).toBe(12);
    expect(calls[0]!.body).toEqual({ filename: "notes.txt", contentType: "text/plain", size: 12 });
  });

  it("says so when the storage refuses the file", async () => {
    files.uploadStatus = 403;
    const { api } = fakeApi({ "/inbox/uploads": () => ({ id: "up1", contentType: "image/png", uploadUrl: "https://media.example.com/up1" }) });
    await expect(upload(api, { uri: "file:///a.png", name: "a.png", contentType: "image/png", size: 1 })).rejects.toThrow("Couldn't upload a.png. Try again.");
  });
});

describe("Draft with AI", () => {
  it("gives the draft, or why there's none in words, the server's own when AI isn't set up", async () => {
    const answer = (value: () => unknown) => draftWithAi(fakeApi({ "/conversations/12/suggested-reply": value }).api, 12);
    const { api, calls } = fakeApi({ "/conversations/12/suggested-reply": () => ({ status: "suggested", draft: "Use Export." }) });
    expect(await draftWithAi(api, 12)).toEqual({ draft: "Use Export." });
    // A POST without a JSON body is refused.
    expect(calls).toEqual([{ path: "/conversations/12/suggested-reply", method: "POST", body: {} }]);
    expect(await answer(() => ({ status: "no_answer", draft: null }))).toEqual({ notice: "Your docs don't cover what they asked, so there's no draft" });
    expect(
      await answer(() => {
        throw new Error("AI isn't set up on this server");
      }),
    ).toEqual({ notice: "AI isn't set up on this server" });
  });

  it("goes below what's already written", () => {
    expect(withDraft("", "Use Export.")).toBe("Use Export.");
    expect(withDraft("Hi Maya,  \n", "Use Export.")).toBe("Hi Maya,\n\nUse Export.");
  });
});

describe("the live stream", () => {
  it("reads whole events across chunks, and skips comments", () => {
    const first = parseEvents("event: ready\ndata: {}\n\n: ping\n\nevent: change\ndata: {\"conver");
    expect(first.events).toEqual([{ event: "ready", data: "{}" }]);
    expect(parseEvents(`${first.rest}sation":12}\n\n`).events).toEqual([{ event: "change", data: '{"conversation":12}' }]);
  });

  const stream = (text: string) =>
    new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(text));
        },
      }),
    );

  it("says which conversation changed, and null for anything (opening, or a change without one)", async () => {
    const changed: (number | null)[] = [];
    const fetchFn = vi.fn(async () => stream('event: ready\ndata: {}\n\nevent: change\ndata: {"conversation":12}\n\nevent: change\ndata: {}\n\n'));
    const stop = watchLive({ server: "https://tuti.example.com", token: "t", project: "acme" }, (number) => changed.push(number), fetchFn);
    await vi.waitFor(() => expect(changed).toEqual([null, 12, null]));
    stop();
    expect(fetchFn).toHaveBeenCalledWith("https://tuti.example.com/api/live", expect.objectContaining({ headers: { accept: "text/event-stream", authorization: "Bearer t", "tuti-project": "acme" } }));
  });

  it("while it can't connect, tries again every 3 seconds and fetches every 10", async () => {
    vi.useFakeTimers();
    const changed: (number | null)[] = [];
    const fetchFn = vi.fn(async () => new Response("{}", { status: 503 }));
    const stop = watchLive({ server: "https://tuti.example.com", token: "t" }, (number) => changed.push(number), fetchFn);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(fetchFn).toHaveBeenCalledTimes(4);
    expect(changed).toEqual([null]);
    stop();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(fetchFn).toHaveBeenCalledTimes(4);
    expect(changed).toEqual([null]);
  });
});

describe("a reply that hasn't arrived", () => {
  const key = "https://tuti.example.com|acme|12";
  const unsent: Unsent = { id: "u1", body: "Fixed now", note: false, close: true, files: [], seen: "2026-11-25T09:00:00.000Z" };

  it("goes back into its composer with Edit, with only the files still young enough to send", () => {
    const now = Date.parse("2026-11-25T09:00:00.000Z");
    const file = (id: string, at: number) => ({ id, name: `${id}.pdf`, contentType: "application/pdf", size: 10, at });
    const note = { ...unsent, note: true, body: "Ravi knows", files: [file("old", now - FILES_LAST_MS), file("new", now)] };
    const edited = editUnsent({ ...EMPTY_DRAFT, unsent: [note] }, note, now);
    expect(edited).toEqual({ reply: "", note: "Ravi knows", files: [file("new", now)], unsent: [], keep: { note: "u1" } });
  });

  it("goes back only into an empty composer with no files: what's there could go out under its id", () => {
    const note = { ...unsent, note: true, body: "Ravi knows" };
    expect(canEdit({ ...EMPTY_DRAFT, unsent: [note] }, note, 0)).toBe(true);
    expect(canEdit({ ...EMPTY_DRAFT, note: "Also: the export", unsent: [note] }, note, 0)).toBe(false);
    expect(canEdit({ ...EMPTY_DRAFT, files: [{ id: "up1", name: "a.png", contentType: "image/png", size: 1, at: Date.now() }], unsent: [note] }, note, 0)).toBe(false);
    // A file still uploading would join it when it's done.
    expect(canEdit({ ...EMPTY_DRAFT, unsent: [note] }, note, 1)).toBe(false);
    // The other composer's words don't matter: they go out under their own id.
    expect(canEdit({ ...EMPTY_DRAFT, reply: "Hi Maya", unsent: [note] }, note, 0)).toBe(true);
    expect(EDIT_FIRST).toBe("Send or clear what's being written first, then Edit.");
  });

  it("uses up an edit's kept id once its words are sent or emptied: what's written next is a new reply", () => {
    const edited = editUnsent({ ...EMPTY_DRAFT, unsent: [unsent] }, unsent);
    expect(unsentId(edited, "reply")).toBe("u1");
    const sent = queueUnsent(edited, "reply", { ...unsent, body: edited.reply });
    expect(sent.reply).toBe("");
    expect(unsentId(sent, "reply")).not.toBe("u1");
    const emptied = typed(typed(edited, "reply", ""), "reply", "Something new");
    expect(unsentId(emptied, "reply")).not.toBe("u1");
    // Typing on, without emptying it, keeps it.
    expect(unsentId(typed(edited, "reply", "Fixed now!"), "reply")).toBe("u1");
  });

  it("is kept in the draft's file as it changes, and tells whoever shows it", () => {
    let told = 0;
    const stop = subscribeDraft(key, () => told++);
    updateDraft(key, (draft) => ({ ...draft, reply: "Hi" }));
    updateDraft(key, (draft) => draft);
    stop();
    expect(told).toBe(1);
    expect(readDraft(key).reply).toBe("Hi");
  });

  it("is sent once however often it's asked for, fetched before it leaves the draft, and gone once it's there", async () => {
    updateDraft(key, (draft) => ({ ...draft, unsent: [unsent] }));
    let answer!: (value: unknown) => void;
    const { api, calls } = fakeApi({ "/conversations/12/messages": () => new Promise((resolve) => (answer = resolve)) });
    const order: string[] = [];
    const saved = async () => {
      order.push(`fetched with ${getDraft(key).unsent.length} unsent`);
      return [];
    };
    const first = sendUnsent(api, key, 12, unsent, saved);
    const again = sendUnsent(api, key, 12, unsent, saved);
    expect(again).toBe(first);
    expect(isSending("u1")).toBe(true);
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    answer({ id: "m9", closed: true });
    expect(await first).toEqual({ id: "m9", closed: true });
    expect(order).toEqual(["fetched with 1 unsent"]);
    expect(isSending("u1")).toBe(false);
    expect(getDraft(key).unsent).toEqual([]);
    expect(readDraft(key)).toEqual(EMPTY_DRAFT);
  });

  it("stays with why when sending fails, no longer sending as that's shown", async () => {
    updateDraft(key, (draft) => ({ ...draft, unsent: [unsent] }));
    const { api } = fakeApi({
      "/conversations/12/messages": () => {
        throw new Error("Couldn't reach tuti.example.com");
      },
    });
    let sendingWhenShown: boolean | undefined;
    const stop = subscribeDraft(key, () => (sendingWhenShown = isSending("u1")));
    expect(await sendUnsent(api, key, 12, unsent, nothing)).toBeNull();
    stop();
    expect(sendingWhenShown).toBe(false);
    expect(readDraft(key).unsent).toEqual([{ ...unsent, error: "Couldn't reach tuti.example.com" }]);
  });
});

describe("drafts and the session", () => {
  const key = "https://tuti.example.com|acme|12";

  it("go with the session that ended only while it's the one in use", () => {
    expect(draftsGoWith({ token: "a" }, { token: "a" })).toBe(true);
    expect(draftsGoWith({ token: "b" }, { token: "a" })).toBe(false);
    expect(draftsGoWith(null, { token: "a" })).toBe(false);
  });

  it("aren't written by work started before signing out (an upload, a send that answers late)", async () => {
    const since = draftsGeneration();
    forgetDrafts();
    updateDraft(key, (draft) => ({ ...draft, files: [{ id: "up1", name: "a.png", contentType: "image/png", size: 1, at: Date.now() }] }), since);
    expect(getDraft(key)).toEqual(EMPTY_DRAFT);
    expect(files.stored.size).toBe(0);
  });
});

describe("reading", () => {
  const conversation = (unread: boolean) => ({ number: 12, unread, messages: [message({ createdAt: "2026-11-25T09:00:00.000Z" })] }) as Conversation;

  it("marks it read only while the teammate is looking: never from a fetch after they've left", async () => {
    const { api, calls } = fakeApi({ "/conversations/12/read": () => ({}) });
    markReadIfLooking(api, conversation(true), false);
    markReadIfLooking(api, conversation(false), true);
    expect(calls).toEqual([]);
    markReadIfLooking(api, conversation(true), true);
    expect(calls).toEqual([{ path: "/conversations/12/read", method: "POST", body: { seen: "2026-11-25T09:00:00.000Z" } }]);
  });
});

it("keeps no space under the composer for the home indicator while the keyboard covers it", () => {
  expect(composerInset(34, false)).toBe(34);
  expect(composerInset(34, true)).toBe(0);
});

it("goes back after Send and close only from the conversation still looked at", () => {
  expect(afterSend({ closed: true }, true)).toEqual({ leave: true, notice: null });
  expect(afterSend({ closed: true }, false)).toEqual({ leave: false, notice: null });
  expect(afterSend({ closed: false }, true)).toEqual({ leave: false, notice: null });
  expect(afterSend(null, true)).toEqual({ leave: false, notice: null });
});

it("stays, and says so in the web's words, when Send and close is kept open as the user wrote again", async () => {
  const key = "https://tuti.example.com|acme|12";
  const unsent: Unsent = { id: "u1", body: "Fixed now", note: false, close: true, files: [], seen: "2026-11-25T09:00:00.000Z" };
  updateDraft(key, (draft) => ({ ...draft, unsent: [unsent] }));
  const { api } = fakeApi({ "/conversations/12/messages": () => ({ id: "m9", keptOpen: true }) });
  const sent = await sendUnsent(api, key, 12, unsent, nothing);
  expect(afterSend(sent, true)).toEqual({ leave: false, notice: "Sent, and kept open: they wrote again since" });
});

describe("a file uploading", () => {
  const key = "https://tuti.example.com|acme|12";

  it("is there for a screen opened again before it's done, and joins the draft once it is", async () => {
    let started!: (value: unknown) => void;
    const { api } = fakeApi({ "/inbox/uploads": () => new Promise((resolve) => (started = resolve)) });
    const uploading = attach(api, key, { uri: "file:///cache/photo.jpg", name: "photo.jpg", contentType: "image/jpeg", size: 2048 });
    // The screen that picked it is gone; a fresh one subscribes and reads what's uploading.
    let told = 0;
    const stop = subscribeDraft(key, () => told++);
    expect(getUploading(key).map((one) => one.name)).toEqual(["photo.jpg"]);
    expect(getDraft(key).files).toEqual([]);
    started({ id: "up1", contentType: "image/jpeg", uploadUrl: "https://media.example.com/up1" });
    await uploading;
    stop();
    expect(getUploading(key)).toEqual([]);
    expect(getDraft(key).files.map((file) => file.id)).toEqual(["up1"]);
    expect(told).toBeGreaterThan(0);
    expect(getUploadFailure(key)).toBeNull();
  });

  it("says why it failed to a screen opened again, till the next pick or a send, and leaves nothing uploading", async () => {
    files.uploadStatus = 403;
    const { api } = fakeApi({ "/inbox/uploads": () => ({ id: "up1", contentType: "image/png", uploadUrl: "https://media.example.com/up1" }) });
    await attach(api, key, { uri: "file:///a.png", name: "a.png", contentType: "image/png", size: 1 });
    // The screen that picked it is gone; a fresh one subscribes and reads why.
    let told = 0;
    const stop = subscribeDraft(key, () => told++);
    expect(getUploadFailure(key)).toBe("Couldn't upload a.png. Try again.");
    expect(getUploading(key)).toEqual([]);
    expect(getDraft(key).files).toEqual([]);
    // A send clears it, and tells the screen.
    clearUploadFailure(key);
    expect(getUploadFailure(key)).toBeNull();
    expect(told).toBe(1);
    // The next pick clears it too.
    await attach(api, key, { uri: "file:///b.png", name: "b.png", contentType: "image/png", size: 1 });
    files.uploadStatus = 200;
    const pick = attach(api, key, { uri: "file:///c.png", name: "c.png", contentType: "image/png", size: 1 });
    expect(getUploadFailure(key)).toBeNull();
    await pick;
    stop();
  });
});

describe("a reply's requestId", () => {
  const key = "https://tuti.example.com|acme|12";
  const thanks: Unsent = { id: "u1", body: "Thanks!", note: false, close: false, files: [], seen: "2026-11-25T09:00:00.000Z" };

  /** The server as #1070 has it: a post with an id it has seen, the same message, answers the reply saved (no keptOpen or closed). */
  function server() {
    const saved = new Map<string, { id: string; body: string }>();
    const posts: { requestId: string }[] = [];
    let loseNext = false;
    const { api } = fakeApi({
      "/conversations/12": () => {
        if (closeFails) {
          throw new ApiError(500, "http_500", "tuti.example.com answered 500. Try again.");
        }
        patches++;
        status = "closed";
        return { number: 12, status: "closed" };
      },
      "/conversations/12/messages": () => {
        const body = posts.at(-1) as unknown as { body: string; requestId: string };
        const repeat = saved.get(body.requestId);
        if (repeat) {
          if (repeat.body !== body.body) {
            throw new ApiError(409, "request_id_used", "This requestId was already used for another reply");
          }
          return { id: repeat.id };
        }
        const message = { id: `m${saved.size + 1}`, body: body.body };
        saved.set(body.requestId, message);
        const { close, seen } = body as unknown as { close?: boolean; seen?: string };
        teamWrote(seen ?? null, !!close);
        if (loseNext) {
          loseNext = false;
          throw new ApiError(0, "unreachable", "Couldn't reach tuti.example.com. Check the address and your connection.");
        }
        return { ...message, keptOpen: false };
      },
    });
    const recording = (async (path: string, init: { body?: unknown } = {}) => {
      posts.push(init.body as { requestId: string });
      return api(path, init as never);
    }) as Api;
    // `conversations.get`'s messages as #1074 gives them: yours, each with the id it was sent with; and the user's after.
    let fetchFails = false;
    const later: Message[] = [];
    let patches = 0;
    let closeFails = false;
    let status: Fetched["status"] = "open";
    // As the server sets it on a team reply (addMessage): kept open while it's open and the user wrote after what the
    // reply saw (`seen`); otherwise closed with Send and close, or waiting on the user.
    const teamWrote = (seen: string | null, close: boolean) => {
      const unseen = later.some((one) => one.author === "user" && (!seen || Date.parse(one.createdAt) > Date.parse(seen)));
      status = status === "open" && unseen ? "open" : close ? "closed" : "waiting";
    };
    const fetch = async (): Promise<Message[]> => {
      if (fetchFails) {
        throw new ApiError(0, "unreachable", "Couldn't reach tuti.example.com. Check the address and your connection.");
      }
      return [...saved.entries()].map(([requestId, sent]) => message({ id: sent.id, author: "team", fromYou: true, body: sent.body, requestId, createdAt: "2026-11-25T09:05:00.000Z" }));
    };
    return {
      api: recording,
      saved,
      posts,
      // Oldest first, as conversations.get answers.
      fetch: async (): Promise<Fetched> => ({ messages: [...(await fetch()), ...later].sort((one, other) => Date.parse(one.createdAt) - Date.parse(other.createdAt)), status }),
      loseAnswer: () => (loseNext = true),
      failFetches: () => (fetchFails = true),
      // The user writing opens it again; a teammate's reply leaves it waiting on them.
      userWrites: (createdAt = "2026-11-25T10:00:00.000Z") => {
        later.push(message({ id: `m-user-${later.length}`, body: "One more thing", createdAt }));
        status = "open";
      },
      // A teammate's reply from the web, having seen up to `seen`.
      teammateWrites: (createdAt = "2026-11-25T10:00:00.000Z", seen = createdAt) => {
        later.push(message({ id: `m-team-${later.length}`, author: "team", name: "Ravi", body: "Also fixed", createdAt }));
        teamWrote(seen, false);
      },
      closeFails: () => (closeFails = true),
      closes: () => patches,
    };
  }

  it("settles a lost answer by posting again with the same id: one message, and the reply ends sent", async () => {
    const { api, saved, posts, loseAnswer } = server();
    updateDraft(key, (draft) => ({ ...draft, unsent: [thanks] }));
    loseAnswer();
    expect(await sendUnsent(api, key, 12, thanks, nothing)).toBeNull();
    expect(getDraft(key).unsent).toEqual([{ ...thanks, error: "Couldn't reach tuti.example.com. Check the address and your connection." }]);
    // Retry: the same id, and the server answers with the reply it saved the first time.
    expect(await sendUnsent(api, key, 12, getDraft(key).unsent[0]!, nothing)).toEqual({ id: "m1" });
    expect(posts.map((post) => post.requestId)).toEqual(["u1", "u1"]);
    expect(saved.size).toBe(1);
    expect(getDraft(key).unsent).toEqual([]);
    // A repeat's answer says nothing of what the first did: no going back, no "kept open".
    expect(afterSend({ id: "m1" }, true)).toEqual({ leave: false, notice: null });
  });

  it("drops an unsent reply whenever a fetch shows its id arrived, not only after a failure", async () => {
    const { api, fetch, loseAnswer } = server();
    updateDraft(key, (draft) => ({ ...draft, unsent: [thanks] }));
    loseAnswer();
    expect(await sendUnsent(api, key, 12, thanks, nothing)).toBeNull();
    expect(getDraft(key).unsent).toHaveLength(1);
    // A later fetch (the stream's, or the screen opened again) shows it was saved: gone, with no "Not sent" left.
    afterFetch(key, await fetch(), draftsGeneration());
    expect(getDraft(key).unsent).toEqual([]);
  });

  it("leaves a reply that's still sending to its own send, though a fetch shows its id", async () => {
    let answer!: (value: unknown) => void;
    const { api } = fakeApi({ "/conversations/12/messages": () => new Promise((resolve) => (answer = resolve)) });
    updateDraft(key, (draft) => ({ ...draft, unsent: [thanks] }));
    const sending = sendUnsent(api, key, 12, thanks, nothing);
    await vi.waitFor(() => expect(answer).toBeDefined());
    afterFetch(key, { messages: [message({ id: "m1", author: "team", fromYou: true, body: "Thanks!", requestId: "u1" })], status: "waiting" }, draftsGeneration());
    expect(getDraft(key).unsent.map((one) => one.id)).toEqual(["u1"]);
    expect(isSending("u1")).toBe(true);
    answer({ id: "m1" });
    await sending;
    expect(getDraft(key).unsent).toEqual([]);
  });

  it("changes no draft from a fetch begun before a sign-out", async () => {
    updateDraft(key, (draft) => ({ ...draft, unsent: [thanks] }));
    const since = draftsGeneration();
    forgetDrafts();
    updateDraft(key, (draft) => ({ ...draft, unsent: [{ ...thanks, id: "u9" }] }));
    afterFetch(key, { messages: [message({ id: "m9", author: "team", fromYou: true, body: "Thanks!", requestId: "u9" })], status: "waiting" }, since);
    expect(getDraft(key).unsent.map((one) => one.id)).toEqual(["u9"]);
  });

  it("keeps the id through Edit: a lost answer, then Edit, then Send, with no fetch between, is one message", async () => {
    const { api, saved, fetch, loseAnswer } = server();
    updateDraft(key, (draft) => ({ ...draft, unsent: [thanks] }));
    loseAnswer();
    await sendUnsent(api, key, 12, thanks, fetch);
    // The fetch after the failure couldn't tell (the send's own); Edit straight away.
    updateDraft(key, (draft) => editUnsent(draft, draft.unsent[0]!));
    expect(getDraft(key).reply).toBe("Thanks!");
    const id = unsentId(getDraft(key), "reply");
    expect(id).toBe("u1");
    const again: Unsent = { ...thanks, id, body: getDraft(key).reply };
    updateDraft(key, (draft) => ({ ...draft, reply: "", unsent: [again] }));
    expect(await sendUnsent(api, key, 12, again, fetch)).toEqual({ id: "m1" });
    expect(saved.size).toBe(1);
    expect(getDraft(key).unsent).toEqual([]);
  });

  it("tells an edit whose first version was sent: it's kept, said plainly, and posted only when sent again on purpose", async () => {
    const { api, saved, fetch, loseAnswer } = server();
    updateDraft(key, (draft) => ({ ...draft, unsent: [thanks] }));
    loseAnswer();
    await sendUnsent(api, key, 12, thanks, nothing);
    updateDraft(key, (draft) => editUnsent(draft, draft.unsent[0]!));
    const edited: Unsent = { ...thanks, id: unsentId(getDraft(key), "reply"), body: "Thanks, Maya!" };
    updateDraft(key, (draft) => ({ ...draft, reply: "", unsent: [edited] }));
    // The server knows the id from the first words (409 request_id_used); the fetch shows it was sent.
    expect(await sendUnsent(api, key, 12, edited, fetch)).toBeNull();
    expect(saved.size).toBe(1);
    // Kept, words and all, under a new id, saying why it wasn't sent (in the draft's file: a reopen or a restart too).
    const kept = getDraft(key).unsent;
    expect(kept).toEqual([{ ...edited, id: expect.not.stringMatching(/^u1$/), key: "u1", error: FIRST_SENT }]);
    expect(readDraft(key).unsent).toEqual(kept);
    // Sent on purpose, it's a follow-up: a second message.
    expect(await sendUnsent(api, key, 12, kept[0]!, fetch)).toMatchObject({ id: "m2" });
    expect(saved.size).toBe(2);
    expect(getDraft(key).unsent).toEqual([]);
  });

  it("lets an id clash out by Edit: a new id, and it's sent", async () => {
    const { api, saved, fetch, posts } = server();
    updateDraft(key, (draft) => ({ ...draft, unsent: [thanks] }));
    await sendUnsent(api, key, 12, thanks, fetch);
    const clash = { ...thanks, body: "Something else" };
    updateDraft(key, (draft) => ({ ...draft, unsent: [clash] }));
    await sendUnsent(api, key, 12, clash, nothing);
    expect(getDraft(key).unsent[0]!.error).toBe(ID_CLASH);
    updateDraft(key, (draft) => editUnsent(draft, draft.unsent[0]!));
    const again: Unsent = { ...clash, id: unsentId(getDraft(key), "reply"), error: undefined };
    expect(again.id).not.toBe("u1");
    updateDraft(key, (draft) => queueUnsent(draft, "reply", again));
    expect(await sendUnsent(api, key, 12, again, fetch)).toMatchObject({ id: "m2" });
    expect(posts.at(-1)!.requestId).toBe(again.id);
    expect(saved.size).toBe(2);
    expect(getDraft(key).unsent).toEqual([]);
  });

  it("closes a Send and close that comes back as a repeat when the conversation still ends with it", async () => {
    const { api, fetch, loseAnswer, closes } = server();
    updateDraft(key, (draft) => ({ ...draft, unsent: [thanks] }));
    loseAnswer();
    await sendUnsent(api, key, 12, thanks, nothing);
    // Edit, the same words, and Send and close: a repeat, which says nothing of closing.
    updateDraft(key, (draft) => editUnsent(draft, draft.unsent[0]!));
    const closing: Unsent = { ...thanks, id: unsentId(getDraft(key), "reply"), close: true };
    updateDraft(key, (draft) => queueUnsent(draft, "reply", closing));
    const sent = await sendUnsent(api, key, 12, closing, fetch);
    expect(closes()).toBe(1);
    expect(afterSend(sent, true)).toEqual({ leave: true, notice: null });
  });

  it("keeps a repeated Send and close open when the user wrote after it, and says when it can't tell", async () => {
    const { api, fetch, loseAnswer, closes, userWrites, failFetches } = server();
    updateDraft(key, (draft) => ({ ...draft, unsent: [thanks] }));
    loseAnswer();
    await sendUnsent(api, key, 12, thanks, nothing);
    userWrites();
    const closing: Unsent = { ...thanks, close: true };
    updateDraft(key, (draft) => ({ ...draft, unsent: [closing] }));
    expect(afterSend(await sendUnsent(api, key, 12, closing, fetch), true)).toEqual({ leave: false, notice: "Sent, and kept open: they wrote again since" });
    failFetches();
    updateDraft(key, (draft) => ({ ...draft, unsent: [closing] }));
    expect(afterSend(await sendUnsent(api, key, 12, closing, fetch), true)).toEqual({
      leave: false,
      notice: "Sent, but not closed: Couldn't reach tuti.example.com. Check the address and your connection.",
    });
    expect(closes()).toBe(0);
  });

  it("keeps a repeated Send and close open when the user wrote after what it answered, before the reply too", async () => {
    const { api, fetch, loseAnswer, closes, userWrites } = server();
    // The user wrote after the teammate's `seen` (09:00) and before the reply: the first post kept it open.
    userWrites("2026-11-25T09:01:00.000Z");
    const closing: Unsent = { ...thanks, close: true };
    updateDraft(key, (draft) => ({ ...draft, unsent: [closing] }));
    loseAnswer();
    await sendUnsent(api, key, 12, closing, nothing);
    expect(afterSend(await sendUnsent(api, key, 12, closing, fetch), true)).toEqual({ leave: false, notice: "Sent, and kept open: they wrote again since" });
    expect(closes()).toBe(0);
  });

  it("closes a repeated Send and close though a teammate wrote after it: only the user's messages keep it open", async () => {
    const { api, fetch, loseAnswer, closes, teammateWrites } = server();
    const closing: Unsent = { ...thanks, close: true };
    updateDraft(key, (draft) => ({ ...draft, unsent: [closing] }));
    loseAnswer();
    await sendUnsent(api, key, 12, closing, nothing);
    teammateWrites();
    expect(afterSend(await sendUnsent(api, key, 12, closing, fetch), true)).toEqual({ leave: true, notice: null });
    expect(closes()).toBe(1);
  });

  it("doesn't say kept open for a retried Send and close that closed it, the user's message answered by a teammate first", async () => {
    const { api, fetch, loseAnswer, closes, userWrites, teammateWrites } = server();
    // Seen at 09:00; the user writes at 09:01, a teammate answers from the web at 09:02, then Send and close (09:05) closes it.
    userWrites("2026-11-25T09:01:00.000Z");
    teammateWrites("2026-11-25T09:02:00.000Z");
    const closing: Unsent = { ...thanks, close: true };
    updateDraft(key, (draft) => ({ ...draft, unsent: [closing] }));
    loseAnswer();
    expect(await sendUnsent(api, key, 12, closing, nothing)).toBeNull();
    // Retry: a repeat, which doesn't say it closed; the conversation does.
    expect(afterSend(await sendUnsent(api, key, 12, closing, fetch), true)).toEqual({ leave: true, notice: null });
    expect(closes()).toBe(0);
  });

  it("closes an edit sent with Send and close when the user's message after seen had a teammate's answer before it", async () => {
    const { api, fetch, loseAnswer, closes, userWrites, teammateWrites } = server();
    userWrites("2026-11-25T09:01:00.000Z");
    teammateWrites("2026-11-25T09:02:00.000Z");
    // A plain Send (09:05) leaves it waiting; its answer is lost. Then Edit, the same words, and Send and close.
    updateDraft(key, (draft) => ({ ...draft, unsent: [thanks] }));
    loseAnswer();
    await sendUnsent(api, key, 12, thanks, nothing);
    updateDraft(key, (draft) => editUnsent(draft, draft.unsent[0]!));
    const closing: Unsent = { ...thanks, id: unsentId(getDraft(key), "reply"), close: true };
    updateDraft(key, (draft) => queueUnsent(draft, "reply", closing));
    expect(afterSend(await sendUnsent(api, key, 12, closing, fetch), true)).toEqual({ leave: true, notice: null });
    expect(closes()).toBe(1);
  });

  it("keeps a repeated Send and close open after a teammate's reply that hadn't seen the user's message (Kodus)", async () => {
    const { api, fetch, loseAnswer, closes, userWrites, teammateWrites } = server();
    // The user writes at 09:01; a teammate replies at 09:02 having seen only up to 09:00: the server keeps it open.
    userWrites("2026-11-25T09:01:00.000Z");
    teammateWrites("2026-11-25T09:02:00.000Z", "2026-11-25T09:00:00.000Z");
    const closing: Unsent = { ...thanks, close: true };
    updateDraft(key, (draft) => ({ ...draft, unsent: [closing] }));
    loseAnswer();
    await sendUnsent(api, key, 12, closing, nothing);
    expect(afterSend(await sendUnsent(api, key, 12, closing, fetch), true)).toEqual({ leave: false, notice: "Sent, and kept open: they wrote again since" });
    expect(closes()).toBe(0);
  });

  it("keeps a Send and close a fetch finds arrived till it's closed: Retry then closes it", async () => {
    const { api, fetch, loseAnswer, closes } = server();
    // A plain Send, its answer lost: waiting on the user. Then Edit, the same words, Send and close, which fails offline.
    updateDraft(key, (draft) => ({ ...draft, unsent: [thanks] }));
    loseAnswer();
    await sendUnsent(api, key, 12, thanks, nothing);
    updateDraft(key, (draft) => editUnsent(draft, draft.unsent[0]!));
    const closing: Unsent = { ...thanks, id: unsentId(getDraft(key), "reply"), close: true };
    updateDraft(key, (draft) => queueUnsent(draft, "reply", closing));
    const offline = fakeApi({
      "/conversations/12/messages": () => {
        throw new ApiError(0, "unreachable", "Couldn't reach tuti.example.com. Check the address and your connection.");
      },
    });
    expect(await sendUnsent(offline.api, key, 12, closing, nothing)).toBeNull();
    // A fetch finds its words arrived, still waiting on the user: sent, the close left for Retry, and said so.
    afterFetch(key, await fetch(), draftsGeneration());
    expect(getDraft(key).unsent).toEqual([{ ...closing, error: CLOSE_LEFT, closeOnly: true }]);
    // A fetch again changes nothing.
    const before = getDraft(key);
    afterFetch(key, await fetch(), draftsGeneration());
    expect(getDraft(key)).toBe(before);
    expect(afterSend(await sendUnsent(api, key, 12, getDraft(key).unsent[0]!, fetch), true)).toEqual({ leave: true, notice: null });
    expect(closes()).toBe(1);
    expect(getDraft(key).unsent).toEqual([]);
    // Once it's closed, a fetch drops one like it without a word.
    const again = { ...closing, id: "u7" };
    const done = withoutSent({ ...EMPTY_DRAFT, unsent: [again] }, { messages: [message({ id: "m7", author: "team", fromYou: true, body: "Thanks!", requestId: "u7" })], status: "closed" }, () => false);
    expect(done.unsent).toEqual([]);
  });

  it("drops a Send and close a fetch finds arrived when the conversation is open: the server did all it would", () => {
    const closing: Unsent = { ...thanks, close: true, error: "Couldn't reach tuti.example.com. Check the address and your connection." };
    const arrived = [message({ id: "m1", author: "team", fromYou: true, body: "Thanks!", requestId: "u1" })];
    expect(withoutSent({ ...EMPTY_DRAFT, unsent: [closing] }, { messages: arrived, status: "open" }, () => false).unsent).toEqual([]);
    expect(withoutSent({ ...EMPTY_DRAFT, unsent: [closing] }, { messages: arrived, status: "closed" }, () => false).unsent).toEqual([]);
  });

  it("says why when closing a repeated Send and close fails", async () => {
    const { api, fetch, loseAnswer, closeFails } = server();
    // A plain Send first, its answer lost; then the same words with Send and close.
    updateDraft(key, (draft) => ({ ...draft, unsent: [thanks] }));
    loseAnswer();
    await sendUnsent(api, key, 12, thanks, nothing);
    const closing: Unsent = { ...thanks, close: true };
    updateDraft(key, (draft) => ({ ...draft, unsent: [closing] }));
    closeFails();
    expect(afterSend(await sendUnsent(api, key, 12, closing, fetch), true)).toEqual({ leave: false, notice: "Sent, but not closed: tuti.example.com answered 500. Try again." });
  });

  it("keeps an edit a fetch finds under its first version's id, though the edit's own send failed: said, and sendable", async () => {
    const { api, saved, fetch, loseAnswer } = server();
    updateDraft(key, (draft) => ({ ...draft, unsent: [thanks] }));
    loseAnswer();
    await sendUnsent(api, key, 12, thanks, nothing);
    // Edit (the id kept), new words; its send fails for want of a network.
    updateDraft(key, (draft) => editUnsent(draft, draft.unsent[0]!));
    const edited: Unsent = { ...thanks, id: unsentId(getDraft(key), "reply"), body: "Thanks, Maya!" };
    updateDraft(key, (draft) => queueUnsent(draft, "reply", edited));
    const offline = fakeApi({
      "/conversations/12/messages": () => {
        throw new ApiError(0, "unreachable", "Couldn't reach tuti.example.com. Check the address and your connection.");
      },
    });
    expect(await sendUnsent(offline.api, key, 12, edited, nothing)).toBeNull();
    // Back online, the next fetch shows the id on the first version: the edit stays, with why, under a new id.
    afterFetch(key, await fetch(), draftsGeneration());
    const kept = getDraft(key).unsent;
    expect(kept).toEqual([{ ...edited, id: expect.not.stringMatching(/^u1$/), key: "u1", error: FIRST_SENT }]);
    // Sending it posts a second message.
    expect(await sendUnsent(api, key, 12, kept[0]!, fetch)).toMatchObject({ id: "m2" });
    expect(saved.size).toBe(2);
    expect(getDraft(key).unsent).toEqual([]);
  });

  it("keeps an edit without the files its first version took, so it can be sent as a follow-up", () => {
    // A fixed time: withoutSent doesn't read it, and the test mustn't depend on the clock.
    const file = (id: string) => ({ id, name: `${id}.png`, contentType: "image/png", size: 1, at: Date.parse("2026-11-25T09:00:00.000Z") });
    const attachment = (id: string) => ({ id, filename: `${id}.png`, contentType: "image/png", size: 1 });
    // The first version went with up1; the edit has new words, up1 again, and a new up2.
    const edit = { ...thanks, body: "Thanks, Maya!", files: [file("up1"), file("up2")] };
    const kept = withoutSent({ ...EMPTY_DRAFT, unsent: [edit] }, { messages: [message({ id: "m1", author: "team", fromYou: true, body: "Thanks!", requestId: "u1", attachments: [attachment("up1")] })], status: "waiting" }, () => false).unsent;
    expect(kept).toEqual([{ ...edit, id: expect.not.stringMatching(/^u1$/), key: "u1", files: [file("up2")], error: FIRST_SENT }]);
  });

  it("drops an unchanged reply whose id arrived without a word", () => {
    const draft = { ...EMPTY_DRAFT, unsent: [thanks] };
    const dropped = withoutSent(draft, { messages: [message({ id: "m1", author: "team", fromYou: true, body: "Thanks!", requestId: "u1" })], status: "waiting" }, () => false);
    expect(dropped.unsent).toEqual([]);
    // Other words, a note, or other files under its id: an edit, kept with why.
    const kept = (fields: Partial<Message>) => withoutSent(draft, { messages: [message({ id: "m1", author: "team", fromYou: true, body: "Thanks!", requestId: "u1", ...fields })], status: "waiting" }, () => false).unsent;
    for (const fields of [{ body: "Thanks" }, { note: true }, { attachments: [{ id: "up9", filename: "a.png", contentType: "image/png", size: 1 }] }]) {
      expect(kept(fields)).toEqual([{ ...thanks, id: expect.not.stringMatching(/^u1$/), key: "u1", error: FIRST_SENT }]);
    }
  });

  it("says the id clash, or why the fetch failed, when the conversation doesn't show the first version", async () => {
    const { api, fetch, failFetches } = server();
    updateDraft(key, (draft) => ({ ...draft, unsent: [thanks] }));
    await sendUnsent(api, key, 12, thanks, fetch);
    // Another reply, by an app bug, with an id the server has for "Thanks!", in a conversation that doesn't show it.
    const clash = { ...thanks, body: "Something else" };
    updateDraft(key, (draft) => ({ ...draft, unsent: [clash] }));
    expect(await sendUnsent(api, key, 12, clash, nothing)).toBeNull();
    expect(getDraft(key).unsent).toEqual([{ ...clash, error: ID_CLASH }]);
    // The fetch fails: kept, with why.
    failFetches();
    expect(await sendUnsent(api, key, 12, clash, fetch)).toBeNull();
    expect(getDraft(key).unsent).toEqual([{ ...clash, error: "Couldn't reach tuti.example.com. Check the address and your connection." }]);
  });

  it("posts two replies saying the same at once, each with its own id", async () => {
    const answers: ((value: unknown) => void)[] = [];
    const { api, calls } = fakeApi({ "/conversations/12/messages": () => new Promise((resolve) => answers.push(resolve)) });
    const again = { ...thanks, id: "u2" };
    updateDraft(key, (draft) => ({ ...draft, unsent: [thanks, again] }));
    const first = sendUnsent(api, key, 12, thanks, nothing);
    const second = sendUnsent(api, key, 12, again, nothing);
    // Both are posted before either answers.
    await vi.waitFor(() => expect(calls).toHaveLength(2));
    expect(calls.map((call) => (call.body as { requestId: string }).requestId)).toEqual(["u1", "u2"]);
    answers[0]!({ id: "m1" });
    answers[1]!({ id: "m2" });
    await Promise.all([first, second]);
    expect(getDraft(key).unsent).toEqual([]);
  });

  it("stays unsent, said in words, when the server knows its id from another reply (409)", async () => {
    const { api, posts } = server();
    updateDraft(key, (draft) => ({ ...draft, unsent: [thanks] }));
    await sendUnsent(api, key, 12, thanks, nothing);
    const clash = { ...thanks, body: "Something else" };
    updateDraft(key, (draft) => ({ ...draft, unsent: [clash] }));
    expect(await sendUnsent(api, key, 12, clash, nothing)).toBeNull();
    expect(posts).toHaveLength(2);
    expect(getDraft(key).unsent).toEqual([{ ...clash, error: ID_CLASH }]);
  });

  it("says the server's own words for the reply's other 409, an attachment just sent with another message", async () => {
    const { api } = fakeApi({
      "/conversations/12/messages": () => {
        throw new ApiError(409, "conflict", "An attachment was just sent with another message: add it again");
      },
    });
    const withFile = { ...thanks, files: [{ id: "up1", name: "a.png", contentType: "image/png", size: 1, at: Date.now() }] };
    updateDraft(key, (draft) => ({ ...draft, unsent: [withFile] }));
    expect(await sendUnsent(api, key, 12, withFile, nothing)).toBeNull();
    expect(getDraft(key).unsent).toEqual([{ ...withFile, error: "An attachment was just sent with another message: add it again" }]);
  });

  it("writes nothing back once signed out while its answer was on its way", async () => {
    let answer!: (value: unknown) => void;
    const { api } = fakeApi({ "/conversations/12/messages": () => new Promise((resolve) => (answer = resolve)) });
    updateDraft(key, (draft) => ({ ...draft, unsent: [thanks] }));
    const sending = sendUnsent(api, key, 12, thanks, nothing);
    await vi.waitFor(() => expect(answer).toBeDefined());
    forgetDrafts();
    answer({ id: "m1" });
    await sending;
    expect(getDraft(key)).toEqual(EMPTY_DRAFT);
    expect(files.stored.size).toBe(0);
  });
});
