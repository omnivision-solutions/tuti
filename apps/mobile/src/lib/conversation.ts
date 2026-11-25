import { Directory, File, Paths } from "expo-file-system";

import type { Api } from "./api";

/**
 * One conversation: what `conversations.get` answers, replying, uploading, Draft with AI, the drafts kept on the phone,
 * and the live stream that says when to fetch it again (apps/web/src/server/operations/conversations.ts has the
 * operations; apps/web/src/lib/app-sign-in.ts the stream's contract).
 */

export type Attachment = { id: string; filename: string; contentType: string; size: number; url?: string | null };

export type Message = {
  id: string;
  author: "user" | "team" | "ai" | "tuti";
  name: string | null;
  body: string;
  note: boolean;
  attachments: Attachment[];
  attachmentsDropped: number;
  createdAt: string;
  fromYou: boolean;
  fromAddress: string | null;
  seenAt: string | null;
  emailStatus: "sent" | "delivered" | "bounced" | "complained" | "failed" | null;
  emailError: string | null;
};

export type Conversation = {
  number: number;
  subject: string;
  status: "open" | "waiting" | "closed";
  user: { id: string | null; name: string | null; email: string | null; verified: boolean };
  company: string | null;
  unread: boolean;
  onlineUntil: string | null;
  messages: Message[];
};

/** What's shown as an image rather than a file: the types the web shows inline. */
const IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp", "image/gif"];
export const isImage = (attachment: Attachment) => IMAGE_TYPES.includes(attachment.contentType) && !!attachment.url;

/** Files a message came with that couldn't be kept, as the web says it. */
export const droppedLine = (dropped: number) => `${dropped === 1 ? "1 attachment wasn't kept" : `${dropped} attachments weren't kept`}: this server has no file storage.`;

export const getConversation = (api: Api, number: number) => api<Conversation>(`/conversations/${number}`);

/** Read up to the latest message shown, never one that came after it. */
export const markRead = (api: Api, conversation: Conversation) =>
  api(`/conversations/${conversation.number}/read`, { method: "POST", body: { seen: conversation.messages.at(-1)?.createdAt ?? null } });

/**
 * Marks it read when it has something unread and the teammate is `looking` (the screen focused, the app in front), as
 * the web reads only while its page is visible and focused: never from a fetch that runs after they've left (a send's).
 */
export function markReadIfLooking(api: Api, conversation: Conversation, looking: boolean) {
  if (conversation.unread && looking) {
    markRead(api, conversation).catch(() => {});
  }
}

/**
 * The space under the composer for the home indicator or navigation bar: none while the keyboard is up, as the keyboard
 * covers that area and the keyboard-avoiding padding already counts it.
 */
export const composerInset = (bottomInset: number, keyboardShown: boolean) => (keyboardShown ? 0 : bottomInset);

/** Who it's with, as the web's Inbox names them. */
export const personName = (user: Conversation["user"]) => user.name ?? user.email ?? "Unknown";

/** Who wrote a message: "You" for your own, a Cc'd sender by their address. */
export function writer(message: Message, person: string): string {
  if (message.author === "user") {
    return message.fromAddress ?? person;
  }
  if (message.fromYou) {
    return "You";
  }
  return message.name ?? (message.author === "ai" ? "AI" : "Tuti");
}

/** Under the team's reply: Seen, or how emailing it went, as the web says it; `problem` when it didn't reach them. */
export function delivery(message: Message): { text: string; problem: boolean } | null {
  if (message.author !== "team" || message.note) {
    return null;
  }
  if (message.seenAt) {
    return { text: "Seen", problem: false };
  }
  const error = message.emailError;
  switch (message.emailStatus) {
    case "sent":
      return { text: "Emailed", problem: false };
    case "delivered":
      return { text: "Emailed and delivered", problem: false };
    case "bounced":
      return { text: `The email bounced${error ? `: ${error}` : ""}`, problem: true };
    case "complained":
      return { text: "They marked the email as spam, so replies aren't emailed to them any more", problem: true };
    case "failed":
      return { text: `Couldn't email it${error ? `: ${error}` : ""}`, problem: true };
    default:
      return null;
  }
}

/** Messages from one sender this close together read as a run: who and when once, under the last. */
const RUN_MS = 5 * 60_000;

/** Whether the message after this one carries its line (who, when, delivery) for both. */
export function runsOn(messages: Message[], index: number, person: string): boolean {
  const message = messages[index]!;
  const next = messages[index + 1];
  return (
    !!next &&
    !message.note &&
    !next.note &&
    next.author === message.author &&
    writer(next, person) === writer(message, person) &&
    Date.parse(next.createdAt) - Date.parse(message.createdAt) < RUN_MS &&
    new Date(next.createdAt).toDateString() === new Date(message.createdAt).toDateString() &&
    delivery(next)?.text === delivery(message)?.text
  );
}

export const isOnline = (onlineUntil: string | null, now = Date.now()) => !!onlineUntil && Date.parse(onlineUntil) > now;

/** When a message was written: the time today, the date and time before. */
export function writtenAt(at: string, now = new Date()): string {
  const date = new Date(at);
  const time = date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  if (date.toDateString() === now.toDateString()) {
    return time;
  }
  const day = date.toLocaleDateString([], { month: "short", day: "numeric", ...(date.getFullYear() !== now.getFullYear() && { year: "numeric" }) });
  return `${day}, ${time}`;
}

export function fileSize(bytes: number): string {
  if (bytes < 1000) {
    return `${bytes} B`;
  }
  if (bytes < 1_000_000) {
    return `${Math.round(bytes / 1000)} KB`;
  }
  return `${(bytes / 1_000_000).toFixed(1)} MB`;
}

/**
 * `text` split around the web addresses in it: plain parts at even indexes, addresses at odd. A copy of the web's
 * (apps/web/src/lib/message-links.ts), as no web code runs in the app: only http(s) addresses; punctuation after one
 * ends the sentence, not the address; a bracket it didn't open isn't part of it.
 */
export function linkParts(text: string): string[] {
  const parts: string[] = [];
  let from = 0;
  for (const match of text.matchAll(/\bhttps?:\/\/[^\s<>"“”]+/gi)) {
    if (match[0].length > 2048) {
      continue;
    }
    const count = (char: string) => match[0].split(char).length - 1;
    const unopened: Record<string, number> = { ")": count(")") - count("("), "]": count("]") - count("[") };
    let end = match[0].length;
    for (; end > 0; end--) {
      const last = match[0][end - 1]!;
      if (last in unopened ? unopened[last]-- <= 0 : !/[.,;:!?'*_‘’…。、]/u.test(last)) {
        break;
      }
    }
    const url = match[0].slice(0, end);
    if (!/^https?:\/\/./i.test(url)) {
      continue;
    }
    parts.push(text.slice(from, match.index), url);
    from = match.index + url.length;
  }
  parts.push(text.slice(from));
  return parts;
}

/** A file uploaded for the next reply or note. */
export type Attached = { id: string; name: string; contentType: string; size: number; at: number };

/** A reply or note sent from here that hasn't arrived: kept with Retry. `error` once it failed (none: sending, or the app closed while it was). */
export type Unsent = { id: string; body: string; note: boolean; close: boolean; files: Attached[]; seen: string | null; error?: string };

/** Whether a message of the server's is this unsent one: yours, the same kind and text, its very files (an upload's id is its attachment's), written after what was seen when it was sent. */
const isSent = (message: Message, unsent: Unsent) =>
  !!unsent.seen &&
  message.fromYou &&
  message.note === unsent.note &&
  message.body === unsent.body &&
  Date.parse(message.createdAt) > Date.parse(unsent.seen) &&
  message.attachments.length === unsent.files.length &&
  unsent.files.every((file) => message.attachments.some((attachment) => attachment.id === file.id));

/** Replies the server can't tell apart (the same kind, text and files): which of them a message is, only its send's answer says. */
const sameAs = (unsent: Unsent) => JSON.stringify([unsent.note, unsent.body, unsent.files.map((file) => file.id).sort()]);

/**
 * The draft once a fetch shows what arrived: an unsent reply or note the server saved though its answer was lost (the
 * app closed, the screen left, the connection dropped) is gone. Each of the server's messages accounts for one unsent
 * one, and never for one already accounted for (`taken`: those matched before, and those a send got back), so of two
 * replies saying the same, the one that didn't arrive stays. One still `waiting` on its send's answer is left to it,
 * and a message that may be its own isn't given to another saying the same; `done`: a send whose answer took its
 * message, left for it to remove. The same draft when none arrived.
 * ponytail: matched by text and files; an idempotency key on conversations.reply would make it exact.
 */
export function withoutArrived(draft: Draft, messages: Message[], waiting: (id: string) => boolean = isSending, done?: string): Draft {
  const taken = new Set(draft.taken);
  const kept = new Map<string, number>();
  for (const unsent of draft.unsent) {
    if (unsent.id !== done && waiting(unsent.id)) {
      kept.set(sameAs(unsent), (kept.get(sameAs(unsent)) ?? 0) + 1);
    }
  }
  const left = draft.unsent.filter((unsent) => {
    if (unsent.id === done || waiting(unsent.id)) {
      return true;
    }
    const free = messages.filter((message) => !taken.has(message.id) && isSent(message, unsent));
    if (free.length <= (kept.get(sameAs(unsent)) ?? 0)) {
      return true;
    }
    taken.add(free[0]!.id);
    return false;
  });
  return left.length === draft.unsent.length ? draft : withUnsent(draft, left, [...taken]);
}

/**
 * The draft with these unsent ones. What's taken stays when none are left: a reply sent next may say the same and answer
 * a fetch that hasn't shown this one's message yet. The latest 50; kept while the app runs (a draft with nothing else
 * isn't written), as a reply after a restart answers a conversation fetched since, with them all.
 */
const withUnsent = (draft: Draft, unsent: Unsent[], taken = draft.taken): Draft => ({ ...draft, unsent, taken: taken.slice(-50) });

/** An unsent reply or note back into the composer, with its files still young enough to send, to change what the server refused. */
export function editUnsent(draft: Draft, unsent: Unsent, now = Date.now()): Draft {
  const into = unsent.note ? "note" : "reply";
  return {
    ...withUnsent(draft, draft.unsent.filter((one) => one.id !== unsent.id)),
    [into]: withDraft(draft[into], unsent.body),
    files: [...draft.files, ...unsent.files.filter((file) => now - file.at < FILES_LAST_MS)],
  };
}

export const sendReply = (api: Api, number: number, unsent: Unsent) =>
  api<{ id: string; closed?: boolean }>(`/conversations/${number}/messages`, {
    method: "POST",
    body: {
      body: unsent.body,
      ...(unsent.note && { note: true }),
      ...(unsent.close && { close: true }),
      ...(unsent.seen && { seen: unsent.seen }),
      ...(unsent.files.length > 0 && { attachments: unsent.files.map((file) => file.id) }),
    },
  });

/** A file picked on the phone; `size` 0 when the picker didn't say. */
export type Picked = { uri: string; name: string; contentType: string; size: number };

/** Uploads a file for a reply (`conversations.upload`): started on the server, then PUT straight to the media storage. */
export async function upload(api: Api, picked: Picked, now = Date.now()): Promise<Attached> {
  const file = new File(picked.uri);
  // Some pickers don't say how big a file is: the file does.
  const size = picked.size || file.size;
  const started = await api<{ id: string; contentType: string; uploadUrl: string }>("/inbox/uploads", {
    method: "POST",
    body: { filename: picked.name, contentType: picked.contentType, size },
  });
  let status: number;
  try {
    ({ status } = await file.upload(started.uploadUrl, { httpMethod: "PUT", headers: { "content-type": started.contentType } }));
  } catch {
    status = 0;
  }
  if (status < 200 || status >= 300) {
    throw new Error(`Couldn't upload ${picked.name}. Try again.`);
  }
  return { id: started.id, name: picked.name, contentType: started.contentType, size, at: now };
}

/** Draft with AI (`conversations.suggestReply`): the draft, or why there's none, in the web's words. */
export async function draftWithAi(api: Api, number: number): Promise<{ draft: string } | { notice: string }> {
  try {
    const answer = await api<{ status: "suggested" | "no_answer" | "unavailable" | "failed"; draft: string | null }>(`/conversations/${number}/suggested-reply`, { method: "POST", body: {} });
    if (answer.status === "suggested" && answer.draft) {
      return { draft: answer.draft };
    }
    return {
      notice:
        answer.status === "no_answer"
          ? "Your docs don't cover what they asked, so there's no draft"
          : answer.status === "unavailable"
            ? "This project is out of AI credits"
            : "The AI couldn't draft a reply: try again",
    };
  } catch (error) {
    // The operation's own words: "AI isn't set up on this server", or why it couldn't be reached.
    return { notice: error instanceof Error ? error.message : String(error) };
  }
}

/** A draft into the reply, below anything already written there. */
export const withDraft = (reply: string, draft: string) => (reply.trim() ? `${reply.trimEnd()}\n\n${draft}` : draft);

/** What's typed in a conversation and not sent yet, kept on the phone: nothing is lost when the app closes or a send fails. */
/** `taken`: the server's messages known to be sends from here (by id), never matched to another unsent one. */
export type Draft = { reply: string; note: string; files: Attached[]; unsent: Unsent[]; taken: string[] };

export const EMPTY_DRAFT: Draft = { reply: "", note: "", files: [], unsent: [], taken: [] };

/** An upload the server hasn't been sent with a reply is deleted after a day: one kept longer can't be sent. */
export const FILES_LAST_MS = 23 * 60 * 60_000;

const drafts = () => new Directory(Paths.document, "drafts");
const draftFile = (key: string) => new File(drafts(), `${encodeURIComponent(key)}.json`);

/** The draft kept for a conversation (`key`: the server, project and number), without files too old to send. */
export function readDraft(key: string, now = Date.now()): Draft {
  try {
    const file = draftFile(key);
    if (!file.exists) {
      return EMPTY_DRAFT;
    }
    const draft = { ...EMPTY_DRAFT, ...(JSON.parse(file.textSync()) as Partial<Draft>) };
    return { ...draft, files: draft.files.filter((attached) => now - attached.at < FILES_LAST_MS) };
  } catch {
    return EMPTY_DRAFT;
  }
}

export function writeDraft(key: string, draft: Draft) {
  const file = draftFile(key);
  if (!draft.reply && !draft.note && draft.files.length === 0 && draft.unsent.length === 0) {
    if (file.exists) {
      file.delete();
    }
    return;
  }
  drafts().create({ intermediates: true, idempotent: true });
  file.writeSync(JSON.stringify(draft));
}

/**
 * The drafts in use, kept here rather than in a screen: a send or an upload that finishes after its screen was left
 * still lands in the draft (and its file), and a screen opened again sees it. `key`: the server, project and number.
 */
const cache = new Map<string, Draft>();
const listeners = new Map<string, Set<() => void>>();
/** Moves on when drafts are forgotten (signing out): work started before then (an upload, a send, Draft with AI) changes no draft after. */
let generation = 0;
export const draftsGeneration = () => generation;

export function getDraft(key: string): Draft {
  if (!cache.has(key)) {
    cache.set(key, readDraft(key));
  }
  return cache.get(key)!;
}

/** `since`: the drafts' generation the change was started in; none, now. */
export function updateDraft(key: string, change: (draft: Draft) => Draft, since = generation) {
  if (since !== generation) {
    return;
  }
  const before = getDraft(key);
  const after = change(before);
  if (after === before) {
    return;
  }
  cache.set(key, after);
  try {
    writeDraft(key, after);
  } catch {}
  listeners.get(key)?.forEach((listener) => listener());
}

export function subscribeDraft(key: string, listener: () => void) {
  const set = listeners.get(key) ?? new Set();
  listeners.set(key, set);
  set.add(listener);
  return () => void set.delete(listener);
}

/** Sends going on, by the unsent's id: one opened again shows "Sending…" and waits on the same request, never a second. */
const sends = new Map<string, { same: string; send: Promise<{ closed?: boolean } | null> }>();
export const isSending = (id: string) => sends.has(id);

/**
 * Sends an unsent reply or note kept in the draft at `key`. `saved` fetches the conversation and answers its messages,
 * or rejects when it can't: once the server has it, so it's there before the unsent one goes; after a failure, as the
 * server may have saved it though its answer was lost; and before a `retry`, which posts only after a check that
 * worked, and only if it still isn't there (a check that failed keeps it unsent with why). Unsent ones a fetch shows
 * arrived are dropped here, from what that fetch answered (the screen may keep a newer fetch's result instead). The
 * answer (`{}` when it was there already), or null when it wasn't sent.
 */
export function sendUnsent(api: Api, key: string, number: number, unsent: Unsent, saved: () => Promise<Message[]>, retry = false) {
  const going = sends.get(unsent.id);
  if (going) {
    return going.send;
  }
  // Replies saying the same in one conversation are sent one at a time: each answer says which message is its own.
  // Another conversation's never wait on them.
  const same = `${key}\u0000${sameAs(unsent)}`;
  const before = [...sends.values()].filter((other) => other.same === same).map((other) => other.send);
  const since = generation;
  // What arrived, from the fetch's own answer; its error when it failed.
  // `sent`: this one's answer took its message. Otherwise this one is looked for too, as it may have arrived.
  const fetched = (sent = false) =>
    saved().then(
      (messages) => {
        updateDraft(key, (draft) => withoutArrived(draft, messages, (id) => id !== unsent.id && isSending(id), sent ? unsent.id : undefined), since);
        return null;
      },
      (error: unknown) => (error instanceof Error ? error.message : String(error)),
    );
  const kept = () => since === generation && getDraft(key).unsent.some((one) => one.id === unsent.id);
  const mark = (error: string | undefined) => (draft: Draft) => ({ ...draft, unsent: draft.unsent.map((one) => (one.id === unsent.id ? { ...one, error } : one)) });
  // Out of `sends` before the draft changes, so what's shown then says it isn't sending any more.
  const send = (async (): Promise<{ closed?: boolean } | null> => {
    await Promise.all(before);
    if (retry) {
      const failed = await fetched();
      if (failed !== null) {
        sends.delete(unsent.id);
        updateDraft(key, mark(failed), since);
        return null;
      }
      if (!kept()) {
        sends.delete(unsent.id);
        return {};
      }
    }
    let sent: { id: string; closed?: boolean };
    try {
      sent = await sendReply(api, number, unsent);
    } catch (error) {
      await fetched();
      sends.delete(unsent.id);
      updateDraft(key, mark(error instanceof Error ? error.message : String(error)), since);
      return null;
    }
    // The message it made is this one's: no other unsent one is matched to it.
    updateDraft(key, (draft) => withUnsent(draft, draft.unsent, [...draft.taken, sent.id]), since);
    await fetched(true);
    sends.delete(unsent.id);
    updateDraft(key, (draft) => withUnsent(draft, draft.unsent.filter((one) => one.id !== unsent.id)), since);
    return sent;
  })();
  sends.set(unsent.id, { same, send });
  updateDraft(key, mark(undefined), since);
  return send;
}

/** Whether a send and close that answered takes the teammate back: only from the conversation they're still looking at, never from a screen opened over it since. */
export const leavesAfter = (sent: { closed?: boolean } | null, focused: boolean) => !!sent?.closed && focused;

/** Whether a session that ended takes the drafts with it: only the one still in use (not one replaced meanwhile). */
export const draftsGoWith = (stored: { token: string } | null, ended: { token: string }) => !!stored && stored.token === ended.token;

/** Signing out leaves nothing of what was being written on the phone. */
export function forgetDrafts() {
  generation++;
  cache.clear();
  try {
    const directory = drafts();
    if (directory.exists) {
      directory.delete();
    }
  } catch {}
}

/** Server-Sent Events from a chunk of the stream: the whole events in it, and what's left to complete with the next chunk. */
export function parseEvents(buffer: string): { events: { event: string; data: string }[]; rest: string } {
  const blocks = buffer.replace(/\r\n?/g, "\n").split("\n\n");
  const rest = blocks.pop()!;
  const events = blocks.flatMap((block) => {
    let event = "message";
    const data: string[] = [];
    for (const line of block.split("\n")) {
      const [, field, value = ""] = /^([^:]*):? ?(.*)$/.exec(line)!;
      if (field === "event") {
        event = value;
      } else if (field === "data") {
        data.push(value);
      }
    }
    // A comment (`: ping`) or a `retry:` alone is no event.
    return data.length > 0 || event !== "message" ? [{ event, data: data.join("\n") }] : [];
  });
  return { events, rest };
}

const RECONNECT_MS = 3000;
const POLL_MS = 10_000;

/**
 * Follows `/api/live` for the session's project till the returned function stops it. `onChange` gets a conversation's
 * number when that one changed, or null when anything may have (the stream (re)opened, or `change` with `{}`). While the
 * stream is down it reconnects every 3 seconds and calls `onChange(null)` every 10, as the web does.
 *
 * ponytail: the conversation screen's own reader, the smallest it needs; the Inbox screen has one of its own, to be
 * merged into one shared reader once both are in.
 */
export function watchLive(session: { server: string; token: string; project?: string }, onChange: (conversation: number | null) => void, fetchFn: typeof fetch = fetch): () => void {
  const controller = new AbortController();
  const { signal } = controller;
  let poll: ReturnType<typeof setInterval> | undefined;
  const stopPolling = () => {
    clearInterval(poll);
    poll = undefined;
  };
  const wait = (ms: number) =>
    new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, ms);
      signal.addEventListener("abort", () => {
        clearTimeout(timer);
        resolve();
      });
    });

  void (async () => {
    while (!signal.aborted) {
      try {
        const response = await fetchFn(`${session.server}/api/live`, {
          headers: { accept: "text/event-stream", authorization: `Bearer ${session.token}`, ...(session.project && { "tuti-project": session.project }) },
          signal,
        });
        if (!response.ok || !response.body) {
          throw new Error(`live: ${response.status}`);
        }
        const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
        let buffer = "";
        for (;;) {
          const { value, done } = await reader.read();
          if (done) {
            break;
          }
          const parsed = parseEvents(buffer + value);
          buffer = parsed.rest;
          for (const { event, data } of parsed.events) {
            if (event === "ready") {
              stopPolling();
              onChange(null);
            } else if (event === "change") {
              let conversation: unknown;
              try {
                conversation = (JSON.parse(data) as { conversation?: unknown }).conversation;
              } catch {}
              onChange(typeof conversation === "number" ? conversation : null);
            }
          }
        }
      } catch {}
      if (signal.aborted) {
        break;
      }
      poll ??= setInterval(() => onChange(null), POLL_MS);
      await wait(RECONNECT_MS);
    }
    stopPolling();
  })();

  return () => {
    controller.abort();
    stopPolling();
  };
}
