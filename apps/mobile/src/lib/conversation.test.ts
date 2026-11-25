import { afterEach, describe, expect, it, vi } from "vitest";

import type { Api } from "./api";
import {
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
  getDraft,
  isSending,
  leavesAfter,
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
  withoutArrived,
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
  it("sends the reply with what it closes, what was seen and its files' ids", async () => {
    const { api, calls } = fakeApi({ "/conversations/12/messages": () => ({ id: "m9", closed: true }) });
    const files = [{ id: "up1", name: "a.png", contentType: "image/png", size: 5, at: 0 }];
    await sendReply(api, 12, { id: "u1", body: "Fixed now", note: false, close: true, files, seen: "2026-11-25T09:00:00.000Z" });
    await sendReply(api, 12, { id: "u2", body: "Ravi knows", note: true, close: false, files: [], seen: null });
    expect(calls).toEqual([
      { path: "/conversations/12/messages", method: "POST", body: { body: "Fixed now", close: true, seen: "2026-11-25T09:00:00.000Z", attachments: ["up1"] } },
      { path: "/conversations/12/messages", method: "POST", body: { body: "Ravi knows", note: true } },
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

  it("finds a reply in the conversation that was saved though its answer was lost: yours, the same text, after what was seen", () => {
    const unsent = { id: "u1", body: "Fixed now", note: false, close: false, files: [], seen: "2026-11-25T09:00:00.000Z" };
    const mine = message({ author: "team", fromYou: true, body: "Fixed now", createdAt: "2026-11-25T09:05:00.000Z" });
    const arrived = (one: Unsent, messages: Message[]) => withoutArrived({ ...EMPTY_DRAFT, unsent: [one] }, messages).unsent.length === 0;
    expect(arrived(unsent, [mine])).toBe(true);
    expect(arrived(unsent, [{ ...mine, createdAt: "2026-11-25T09:00:00.000Z" }])).toBe(false);
    expect(arrived(unsent, [{ ...mine, fromYou: false }])).toBe(false);
    expect(arrived(unsent, [{ ...mine, note: true }])).toBe(false);
    // Sent before anything was seen: never matched to an older message of the same words.
    expect(arrived({ ...unsent, seen: null }, [mine])).toBe(false);
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

  it("leaves the draft once a fetch has it, and the same draft when none arrived", () => {
    const draft = { ...EMPTY_DRAFT, unsent: [unsent, { ...unsent, id: "u2", body: "Other" }] };
    const mine = message({ author: "team", fromYou: true, body: "Fixed now", createdAt: "2026-11-25T09:05:00.000Z" });
    expect(withoutArrived(draft, [mine]).unsent.map((one) => one.id)).toEqual(["u2"]);
    expect(withoutArrived(draft, [])).toBe(draft);
  });

  it("goes back into its composer with Edit, with only the files still young enough to send", () => {
    const now = Date.parse("2026-11-25T09:00:00.000Z");
    const file = (id: string, at: number) => ({ id, name: `${id}.pdf`, contentType: "application/pdf", size: 10, at });
    const note = { ...unsent, note: true, body: "Ravi knows", files: [file("old", now - FILES_LAST_MS), file("new", now)] };
    const edited = editUnsent({ ...EMPTY_DRAFT, note: "Also:", unsent: [note] }, note, now);
    expect(edited).toEqual({ reply: "", note: "Also:\n\nRavi knows", files: [file("new", now)], unsent: [], taken: [] });
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
    expect(await sendUnsent(api, key, 12, unsent, async () => [])).toBeNull();
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

describe("a send whose answer was lost", () => {
  const key = "https://tuti.example.com|acme|12";
  const unsent: Unsent = { id: "u1", body: "Fixed now", note: false, close: false, files: [], seen: "2026-11-25T09:00:00.000Z" };
  const saved = [message({ author: "team", fromYou: true, body: "Fixed now", createdAt: "2026-11-25T09:05:00.000Z" })];
  // The screen's fetch: what the server has, and the draft without what arrived.
  const fetchShows = (messages: Message[]) => async () => {
    updateDraft(key, (draft) => withoutArrived(draft, messages));
    return messages;
  };

  it("is found by the fetch after the failure, and isn't offered again", async () => {
    updateDraft(key, (draft) => ({ ...draft, unsent: [unsent] }));
    const { api } = fakeApi({
      "/conversations/12/messages": () => {
        throw new Error("Couldn't reach tuti.example.com");
      },
    });
    expect(await sendUnsent(api, key, 12, unsent, fetchShows(saved))).toBeNull();
    expect(getDraft(key).unsent).toEqual([]);
  });

  it("isn't posted again by Retry once the server has it", async () => {
    updateDraft(key, (draft) => ({ ...draft, unsent: [{ ...unsent, error: "Couldn't reach tuti.example.com" }] }));
    const { api, calls } = fakeApi({ "/conversations/12/messages": () => ({ id: "m9" }) });
    expect(await sendUnsent(api, key, 12, unsent, fetchShows(saved), true)).toEqual({});
    expect(calls).toEqual([]);
    expect(getDraft(key).unsent).toEqual([]);
  });

  it("is posted by Retry when the server hasn't got it", async () => {
    updateDraft(key, (draft) => ({ ...draft, unsent: [{ ...unsent, error: "Couldn't reach tuti.example.com" }] }));
    const { api, calls } = fakeApi({ "/conversations/12/messages": () => ({ id: "m9" }) });
    expect(await sendUnsent(api, key, 12, unsent, fetchShows([]), true)).toEqual({ id: "m9" });
    expect(calls).toHaveLength(1);
    expect(getDraft(key).unsent).toEqual([]);
  });
});

describe("a send's own fetch", () => {
  const key = "https://tuti.example.com|acme|12";
  const unsent: Unsent = { id: "u1", body: "Fixed now", note: false, close: false, files: [], seen: "2026-11-25T09:00:00.000Z" };
  const saved = [message({ author: "team", fromYou: true, body: "Fixed now", createdAt: "2026-11-25T09:05:00.000Z" })];
  // The screen kept a newer fetch's result instead of this one's: only the answered messages say what arrived.
  const answers = (messages: Message[]) => async () => messages;

  it("drops a reply it shows arrived, though the screen kept another fetch's result: Retry posts nothing", async () => {
    updateDraft(key, (draft) => ({ ...draft, unsent: [{ ...unsent, error: "Couldn't reach tuti.example.com" }] }));
    const { api, calls } = fakeApi({ "/conversations/12/messages": () => ({ id: "m9" }) });
    expect(await sendUnsent(api, key, 12, unsent, answers(saved), true)).toEqual({});
    expect(calls).toEqual([]);
    expect(getDraft(key).unsent).toEqual([]);
  });

  it("drops a reply whose answer was lost when the fetch after the failure shows it", async () => {
    updateDraft(key, (draft) => ({ ...draft, unsent: [unsent] }));
    const { api } = fakeApi({
      "/conversations/12/messages": () => {
        throw new Error("Couldn't reach tuti.example.com");
      },
    });
    expect(await sendUnsent(api, key, 12, unsent, answers(saved))).toBeNull();
    expect(getDraft(key).unsent).toEqual([]);
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

describe("telling which reply arrived", () => {
  const key = "https://tuti.example.com|acme|12";
  const seen = "2026-11-25T09:00:00.000Z";
  const thanks: Unsent = { id: "u1", body: "Thanks!", note: false, close: false, files: [], seen };
  const mine = (id: string, fields: Partial<Message> = {}) => message({ id, author: "team", fromYou: true, body: "Thanks!", createdAt: "2026-11-25T09:05:00.000Z", ...fields });
  const file = (id: string) => ({ id, name: `${id}.png`, contentType: "image/png", size: 1, at: Date.now() });
  const attachment = (id: string) => ({ id, filename: `${id}.png`, contentType: "image/png", size: 1 });

  it("counts each of the server's messages once: of two replies saying the same, one arriving leaves the other", () => {
    const draft = { ...EMPTY_DRAFT, unsent: [thanks, { ...thanks, id: "u2" }] };
    const left = withoutArrived(draft, [mine("m1")]);
    expect(left.unsent.map((one) => one.id)).toEqual(["u2"]);
    expect(left.taken).toEqual(["m1"]);
    // The next fetch still has m1: it's taken, so u2 stays till its own message is there.
    expect(withoutArrived(left, [mine("m1")])).toBe(left);
    expect(withoutArrived(left, [mine("m1"), mine("m2")]).unsent).toEqual([]);
  });

  it("matches the files too: the same text with other files, or none, isn't this reply", () => {
    const withFile = { ...thanks, files: [file("up1")] };
    const draft = { ...EMPTY_DRAFT, unsent: [withFile] };
    expect(withoutArrived(draft, [mine("m1")])).toBe(draft);
    expect(withoutArrived(draft, [mine("m1", { attachments: [attachment("up2")] })])).toBe(draft);
    expect(withoutArrived(draft, [mine("m1", { attachments: [attachment("up1"), attachment("up2")] })])).toBe(draft);
    expect(withoutArrived(draft, [mine("m1", { attachments: [attachment("up1")] })]).unsent).toEqual([]);
  });

  it("never takes another send's message for this one: a second reply saying the same, still sending, stays", async () => {
    const second = { ...thanks, id: "u2" };
    updateDraft(key, (draft) => ({ ...draft, unsent: [thanks, second] }));
    const { api } = fakeApi({ "/conversations/12/messages": () => ({ id: "m1" }) });
    // The first one's fetch answered before its message showed; the first leaves the draft all the same.
    expect(await sendUnsent(api, key, 12, thanks, async () => [])).toEqual({ id: "m1" });
    expect(getDraft(key).unsent).toEqual([second]);
    // The next fetch (the live stream's) has the first one's message, and the second's isn't there yet.
    updateDraft(key, (draft) => withoutArrived(draft, [mine("m1")]));
    expect(getDraft(key).unsent).toEqual([second]);
  });

  it("keeps a failed reply when the same text, sent again, shows before its answer: the message may be the new one's", async () => {
    const failed = { ...thanks, error: "Couldn't reach tuti.example.com" };
    const again = { ...thanks, id: "u2" };
    updateDraft(key, (draft) => ({ ...draft, unsent: [failed, again] }));
    let answer!: (value: unknown) => void;
    const { api, calls } = fakeApi({ "/conversations/12/messages": () => new Promise((resolve) => (answer = resolve)) });
    const sending = sendUnsent(api, key, 12, again, async () => [mine("m2")]);
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    // The live stream's fetch has the new one's message before its answer is in.
    updateDraft(key, (draft) => withoutArrived(draft, [mine("m2")]));
    expect(getDraft(key).unsent.map((one) => one.id)).toEqual(["u1", "u2"]);
    answer({ id: "m2" });
    await sending;
    expect(getDraft(key).unsent).toEqual([failed]);
  });

  it("sends replies saying the same one at a time, so each answer says which message is its own", async () => {
    const again = { ...thanks, id: "u2" };
    updateDraft(key, (draft) => ({ ...draft, unsent: [thanks, again] }));
    const answers: ((value: unknown) => void)[] = [];
    const { api, calls } = fakeApi({ "/conversations/12/messages": () => new Promise((resolve) => answers.push(resolve)) });
    const first = sendUnsent(api, key, 12, thanks, async () => []);
    const second = sendUnsent(api, key, 12, again, async () => []);
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    // Everything waiting to run has run (no clock involved): the second still waits for the first's answer.
    await new Promise((resolve) => setImmediate(resolve));
    expect(calls).toHaveLength(1);
    answers[0]!({ id: "m1" });
    await first;
    await vi.waitFor(() => expect(calls).toHaveLength(2));
    answers[1]!({ id: "m2" });
    await second;
    expect(getDraft(key).unsent).toEqual([]);
  });

  it("remembers a send's message after the last unsent one leaves: a failed reply saying the same, sent next, stays", async () => {
    updateDraft(key, (draft) => ({ ...draft, unsent: [thanks] }));
    // Sent; the fetch after it hadn't shown its message yet.
    expect(await sendUnsent(fakeApi({ "/conversations/12/messages": () => ({ id: "m1" }) }).api, key, 12, thanks, async () => [])).toEqual({ id: "m1" });
    expect(getDraft(key).unsent).toEqual([]);
    // The same again, answering what was seen before m1; it fails, and the fetch after shows only m1.
    const again = { ...thanks, id: "u2" };
    updateDraft(key, (draft) => ({ ...draft, unsent: [again] }));
    const failing = fakeApi({
      "/conversations/12/messages": () => {
        throw new Error("Couldn't reach tuti.example.com");
      },
    });
    expect(await sendUnsent(failing.api, key, 12, again, async () => [mine("m1")])).toBeNull();
    expect(getDraft(key).unsent).toEqual([{ ...again, error: "Couldn't reach tuti.example.com" }]);
  });

  it("isn't posted again by Retry after a check that failed: it stays unsent with why", async () => {
    const failed = { ...thanks, error: "Couldn't reach tuti.example.com" };
    updateDraft(key, (draft) => ({ ...draft, unsent: [failed] }));
    const { api, calls } = fakeApi({ "/conversations/12/messages": () => ({ id: "m1" }) });
    const check = async (): Promise<Message[]> => {
      throw new Error("Couldn't reach tuti.example.com. Check the address and your connection.");
    };
    expect(await sendUnsent(api, key, 12, failed, check, true)).toBeNull();
    expect(calls).toEqual([]);
    expect(isSending("u1")).toBe(false);
    expect(getDraft(key).unsent).toEqual([{ ...thanks, error: "Couldn't reach tuti.example.com. Check the address and your connection." }]);
  });
});

it("goes back after Send and close only from the conversation still looked at", () => {
  expect(leavesAfter({ closed: true }, true)).toBe(true);
  expect(leavesAfter({ closed: true }, false)).toBe(false);
  expect(leavesAfter({ closed: false }, true)).toBe(false);
  expect(leavesAfter(null, true)).toBe(false);
});
