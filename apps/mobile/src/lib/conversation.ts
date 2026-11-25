import { Directory, File, Paths } from "expo-file-system";

import { type Api, ApiError } from "./api";

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
  /** The id your reply was sent with (`requestId`), on your own messages only; null on others' (and from a server before #1074: absent). */
  requestId?: string | null;
};

export type Conversation = {
  number: number;
  subject: string;
  status: "open" | "waiting" | "closed";
  assignee: { name: string; email: string } | null;
  spam: boolean;
  snoozedUntil: string | null;
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
/**
 * Who wants to know a conversation was marked read, by its number: the Inbox, which shows it unread till it fetches its
 * row again. A read sends no live change (unread is each teammate's own), and it may finish after the Inbox fetched the
 * row on coming back.
 */
const readListeners = new Set<(number: number) => void>();
export function onRead(listener: (number: number) => void) {
  readListeners.add(listener);
  return () => void readListeners.delete(listener);
}

export const markRead = (api: Api, conversation: Conversation) =>
  api(`/conversations/${conversation.number}/read`, { method: "POST", body: { seen: conversation.messages.at(-1)?.createdAt ?? null } }).then((answer) => {
    readListeners.forEach((listener) => listener(conversation.number));
    return answer;
  });

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

/**
 * A reply or note sent from here that hasn't arrived: kept with Retry. `error` once it failed (none: sending, or the app
 * closed while it was). Its `id` goes with every post of it as `requestId`: a post again after a lost answer gets the
 * reply already saved, never a second one (conversations.reply).
 */
/** `closeOnly`: a Send and close whose reply arrived, only the close left (`error` says so, `CLOSE_LEFT`). */
export type Unsent = { id: string; body: string; note: boolean; close: boolean; files: Attached[]; seen: string | null; error?: string; key?: string; closeOnly?: boolean };

/** Said on a Send and close whose reply went out but whose close didn't: Retry closes it. */
export const CLOSE_LEFT = "Sent, but not closed: tap Retry to close it.";

/** Which bubble an unsent reply is, for the list: the id it was first made with, kept when an edit is given a new id. */
export const unsentKey = (unsent: Unsent) => unsent.key ?? unsent.id;

/**
 * Edits kept since `before` because their first version had already gone out (`FIRST_SENT`): to say, as a screen reader
 * would otherwise hear only "Not sent". By `unsentKey`, so a bubble given a new id is the same one.
 */
export const newlyKept = (before: Unsent[], after: Unsent[]) =>
  after.filter((one) => one.error === FIRST_SENT && !before.some((was) => unsentKey(was) === unsentKey(one) && was.error === FIRST_SENT));

/**
 * Whether Edit can put an unsent reply or note back into its composer: only an empty one, with no files attached or
 * `uploading` (one finishing after would join it). It
 * keeps the reply's id (see `editUnsent`), so nothing else may go out under it: words or files already there would be
 * dropped with it if its first version turns out sent, or send another's words twice.
 */
export const canEdit = (draft: Draft, unsent: Unsent, uploading: number) =>
  !draft[unsent.note ? "note" : "reply"].trim() && draft.files.length === 0 && uploading === 0;

/** Said when Edit can't, as the composer has something in it. */
export const EDIT_FIRST = "Send or clear what's being written first, then Edit.";

/**
 * An unsent reply or note back into its composer (an empty one: `canEdit`), with its files still young enough to send,
 * to change what the server refused. Its id goes with it till it's sent: if its first post arrived though its answer was
 * lost, the server knows the id (a repeat, or `request_id_used` for changed words), so an edit can't post a second reply.
 * One the server knows from another reply's words (`ID_CLASH`) gets a new id, or it could never go out.
 */
export function editUnsent(draft: Draft, unsent: Unsent, now = Date.now()): Draft {
  const into = unsent.note ? "note" : "reply";
  return {
    ...draft,
    unsent: draft.unsent.filter((one) => one.id !== unsent.id),
    [into]: unsent.body,
    files: unsent.files.filter((file) => now - file.at < FILES_LAST_MS),
    keep: { ...draft.keep, [into]: unsent.error === ID_CLASH ? undefined : unsent.id },
  };
}

/** What's typed into a composer; emptied, an edited reply's kept id goes with its words, so what's typed next is a new reply. */
export const typed = (draft: Draft, kind: "reply" | "note", text: string): Draft => ({
  ...draft,
  [kind]: text,
  ...(!text && { keep: { ...draft.keep, [kind]: undefined } }),
});

/** The draft once a composer's words are sent: they and the files leave it as `unsent`, and an id kept for them is used up. */
export const queueUnsent = (draft: Draft, kind: "reply" | "note", unsent: Unsent): Draft => ({
  ...draft,
  [kind]: "",
  files: [],
  unsent: [...draft.unsent, unsent],
  keep: { ...draft.keep, [kind]: undefined },
});

/**
 * The draft once a fetch shows what arrived: an unsent reply whose id is a fetched message's `requestId` was saved
 * though its answer was lost, whenever that's noticed (a later fetch, the screen opened again). The same reply as saved
 * goes; a different one (an edit, which kept the id) stays, with a new id and `FIRST_SENT` as its error, so the teammate
 * can Delete it or send it on purpose as a follow-up, never retyping it (without the files the first version took). One still `sending` is left to its own send.
 */
export function withoutSent(draft: Draft, fetched: Fetched, sending: (id: string) => boolean = isSending): Draft {
  const sent = new Map(fetched.messages.flatMap((message) => (message.requestId ? [[message.requestId, message] as const] : [])));
  let changed = false;
  const unsent = draft.unsent.flatMap((one) => {
    const first = sent.get(one.id);
    if (sending(one.id) || !first) {
      return [one];
    }
    // A Send and close that arrived, the conversation still waiting on the user: sent, only the close is left, for Retry
    // (its repeat closes it, `closeRepeat`). Open or closed, the server already did all it would (kept it open for a
    // waiting user, or the user opened it again): it goes, as any reply that arrived.
    if (one.close && fetched.status === "waiting" && sameMessage(first, one)) {
      if (one.closeOnly) {
        return [one];
      }
      changed = true;
      return [{ ...one, closeOnly: true, error: CLOSE_LEFT }];
    }
    changed = true;
    // Its files already on the first version went with it (a file goes with one message): the follow-up has the rest.
    const files = one.files.filter((file) => !first.attachments.some((attachment) => attachment.id === file.id));
    return sameMessage(first, one) ? [] : [{ ...one, key: unsentKey(one), id: newUnsentId(), files, error: FIRST_SENT }];
  });
  return changed ? { ...draft, unsent } : draft;
}

/** Whether a saved message is this unsent reply as written: the same kind, words and files. */
const sameMessage = (message: Message, unsent: Unsent) =>
  message.note === unsent.note &&
  message.body === unsent.body &&
  message.attachments.length === unsent.files.length &&
  unsent.files.every((file) => message.attachments.some((attachment) => attachment.id === file.id));

/**
 * What the server says of a reply sent: `closed` with Send and close, `keptOpen` when the user wrote after what it
 * answered. `notClosed`: sent, but Send and close couldn't close it (why). An edit whose first version had already been
 * sent stays unsent, said (`withoutSent`).
 */
export type Sent = { id?: string; closed?: boolean; keptOpen?: boolean; notClosed?: string };

export const sendReply = (api: Api, number: number, unsent: Unsent) =>
  api<Sent & { id: string }>(`/conversations/${number}/messages`, {
    method: "POST",
    body: {
      body: unsent.body,
      ...(unsent.note && { note: true }),
      ...(unsent.close && { close: true }),
      ...(unsent.seen && { seen: unsent.seen }),
      ...(unsent.files.length > 0 && { attachments: unsent.files.map((file) => file.id) }),
      requestId: unsent.id,
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
/** `keep`: the id an edited reply or note keeps till it's sent (see `editUnsent`), by composer. */
export type Draft = { reply: string; note: string; files: Attached[]; unsent: Unsent[]; keep?: { reply?: string; note?: string } };

export const EMPTY_DRAFT: Draft = { reply: "", note: "", files: [], unsent: [] };

/**
 * What a fetch of the conversation at `key` does to its draft (`withoutSent`), begun in the drafts' generation `since`:
 * a fetch that answers after a sign-out changes nothing, so it can't touch the next teammate's drafts.
 */
export const afterFetch = (key: string, fetched: Fetched, since: number) => updateDraft(key, (draft) => withoutSent(draft, fetched), since);

const newUnsentId = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;

/** A new reply's id (its `requestId`): one an edit kept, or a new one. */
export const unsentId = (draft: Draft, kind: "reply" | "note") => draft.keep?.[kind] ?? newUnsentId();

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
  tell(key);
}

const tell = (key: string) => listeners.get(key)?.forEach((listener) => listener());

export function subscribeDraft(key: string, listener: () => void) {
  const set = listeners.get(key) ?? new Set();
  listeners.set(key, set);
  set.add(listener);
  return () => void set.delete(listener);
}

/** Sends going on, by the unsent's id: one opened again shows "Sending…" and waits on the same request, never a second. */
/**
 * Files uploading for a draft, by its key, kept here rather than in a screen (as sends are): a screen opened again while
 * one uploads shows it and keeps Send off till it's done, so a reply doesn't go without it and the file doesn't land in
 * whatever is sent next. `subscribeDraft` tells of changes here too.
 */
export type Uploading = { id: number; name: string };
const uploads = new Map<string, Uploading[]>();
const NONE: Uploading[] = [];
let picks = 0;
export const getUploading = (key: string) => uploads.get(key) ?? NONE;
const setUploading = (key: string, change: (now: Uploading[]) => Uploading[]) => {
  const next = change(getUploading(key));
  if (next.length > 0) {
    uploads.set(key, next);
  } else {
    uploads.delete(key);
  }
  tell(key);
};

/** Why the latest upload for a draft failed, kept here too: the screen open then says it, whichever screen picked the file. */
const uploadFailures = new Map<string, string>();
export const getUploadFailure = (key: string) => uploadFailures.get(key) ?? null;
export function clearUploadFailure(key: string) {
  if (uploadFailures.delete(key)) {
    tell(key);
  }
}

/** Uploads a picked file into the draft at `key`; why it didn't is `getUploadFailure(key)`, till the next pick or a send. */
export function attach(api: Api, key: string, picked: Picked): Promise<void> {
  const since = generation;
  const pick = { id: ++picks, name: picked.name };
  uploadFailures.delete(key);
  setUploading(key, (now) => [...now, pick]);
  return upload(api, picked)
    .then(
      (attached) => updateDraft(key, (draft) => ({ ...draft, files: [...draft.files, attached] }), since),
      (error: unknown) => {
        if (since === generation) {
          uploadFailures.set(key, error instanceof Error ? error.message : String(error));
        }
      },
    )
    .finally(() => setUploading(key, (now) => now.filter((one) => one.id !== pick.id)));
}

const sends = new Map<string, Promise<Sent | null>>();
export const isSending = (id: string) => sends.has(id);

/** Said for a reply whose id the server knows from another reply (`request_id_used`): an app bug, as each unsent one has its own id. */
export const ID_CLASH = "Another reply was sent with this one's id. Edit it to send it as a new one.";

/**
 * Sends an unsent reply or note kept in the draft at `key`, with its id as `requestId`. Once the server has it, `saved`
 * fetches the conversation (so it's there before the unsent one goes), and it leaves the draft; failing, it stays with
 * why, and Retry posts it again with the same id: one whose answer was lost comes back as the reply already saved,
 * without `closed` or `keptOpen` (a repeat's answer doesn't say what the first did). `request_id_used` (an edit whose
 * first version was sent): `saved` fetches the conversation, answering its messages or rejecting, to tell which. The
 * answer, or null when it wasn't sent.
 */
/** What a send's fetch of the conversation answers: its messages, and its status (a Send and close repeated needs it). */
export type Fetched = Pick<Conversation, "messages" | "status">;

export function sendUnsent(api: Api, key: string, number: number, unsent: Unsent, saved: () => Promise<Fetched>) {
  const going = sends.get(unsent.id);
  if (going) {
    return going;
  }
  const since = generation;
  // Sending again, it's no longer "only the close left" till a fetch says so.
  // Only the close left (a Send and close whose reply arrived): cleared while it sends, and kept if it fails, as its reply
  // went all the same.
  const closeOnly = getDraft(key).unsent.find((one) => one.id === unsent.id)?.closeOnly ?? unsent.closeOnly;
  const mark = (error: string | undefined) => (draft: Draft) => ({
    ...draft,
    unsent: draft.unsent.map((one) =>
      one.id !== unsent.id ? one : error && closeOnly ? { ...one, error: `Sent, but not closed: ${error}`, closeOnly: true } : { ...one, error, closeOnly: undefined },
    ),
  });
  const drop = (draft: Draft) => ({ ...draft, unsent: draft.unsent.filter((one) => one.id !== unsent.id) });
  // Out of `sends` before the draft changes, so what's shown then says it isn't sending any more.
  const send = (async (): Promise<Sent | null> => {
    let sent: Sent & { id: string };
    try {
      sent = await sendReply(api, number, unsent);
    } catch (error) {
      if (error instanceof ApiError && error.code === "request_id_used") {
        // The server knows this id from other words. Its first version is in the conversation (an edit after a lost
        // answer): kept as a follow-up to Delete or send. Otherwise an app bug: said as such. Asked each time: nothing is stored.
        let fetched: Fetched;
        try {
          fetched = await saved();
        } catch (failed) {
          sends.delete(unsent.id);
          updateDraft(key, mark(failed instanceof Error ? failed.message : String(failed)), since);
          return null;
        }
        sends.delete(unsent.id);
        if (fetched.messages.some((message) => message.requestId === unsent.id)) {
          // Its first version is there: kept under a new id, said, as a fetch does (`withoutSent`).
          updateDraft(key, (draft) => withoutSent(draft, fetched), since);
          return null;
        }
        updateDraft(key, mark(ID_CLASH), since);
        return null;
      }
      sends.delete(unsent.id);
      // The reply's other 409 (an attachment just sent with another message) and the rest say their own words.
      updateDraft(key, mark(error instanceof Error ? error.message : String(error)), since);
      return null;
    }
    const fetched = await saved().then(
      (conversation) => conversation,
      (error: unknown) => ({ why: error instanceof Error ? error.message : String(error) }),
    );
    const answer = unsent.close && sent.closed === undefined && sent.keptOpen === undefined ? await closeRepeat(api, number, fetched) : sent;
    sends.delete(unsent.id);
    updateDraft(key, drop, since);
    return answer;
  })();
  sends.set(unsent.id, send);
  updateDraft(key, mark(undefined), since);
  return send;
}

/**
 * Send and close answered as a repeat (an edit or a retry whose first post arrived, which may not have closed it): the
 * server doesn't say what the first did, but the conversation's status is its answer. Closed: closed. Open: kept open, as
 * the server leaves it open exactly while a user's message is unanswered (and the user writing opens it again). Waiting
 * on the user: closed here. Said when that can't be told or done.
 */
async function closeRepeat(api: Api, number: number, fetched: Fetched | { why: string }): Promise<Sent> {
  if ("why" in fetched) {
    return { notClosed: fetched.why };
  }
  if (fetched.status === "closed") {
    return { closed: true };
  }
  if (fetched.status === "open") {
    return { keptOpen: true };
  }
  try {
    await api(`/conversations/${number}`, { method: "PATCH", body: { status: "closed" } });
    return { closed: true };
  } catch (error) {
    return { notClosed: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * What a reply's answer means on the screen: back to the Inbox once it's closed, only from the conversation still looked at
 * (never from a screen opened over it since); and, kept open as the user wrote again since, the web's words for it, so
 * nobody leaves thinking it's done or waiting on them.
 */
export const afterSend = (sent: Sent | null, focused: boolean) => ({
  leave: !!sent?.closed && focused,
  notice: sent?.keptOpen ? "Sent, and kept open: they wrote again since" : sent?.notClosed ? `Sent, but not closed: ${sent.notClosed}` : null,
});

/** Said on an edit kept unsent as its first version had already gone out (a 409, or a fetch: `withoutSent`). */
export const FIRST_SENT = "Your first version was already sent, so this edited one wasn't.";

/** Whether a session that ended takes the drafts with it: only the one still in use (not one replaced meanwhile). */
export const draftsGoWith = (stored: { token: string } | null, ended: { token: string }) => !!stored && stored.token === ended.token;

/** Signing out leaves nothing of what was being written on the phone. */
export function forgetDrafts() {
  generation++;
  cache.clear();
  uploads.clear();
  uploadFailures.clear();
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
