import { randomUUID } from "expo-crypto";
import { SQLiteStorage } from "expo-sqlite/kv-store";
import { useEffect, useState } from "react";

import { spokenAgeOf } from "./inbox";

/**
 * What was last loaded, kept on the phone to be read with no connection: the Inbox's views and lists (per project and
 * view), the conversations opened and their Activity's newest page. Expo's SQLite key-value store, a database of its own. One account's at a time:
 * signing out, or a session the server ended, forgets it all (`forgetCached`), so whoever signs in next never sees the
 * last one's customers. And it belongs to one session: a sign-in clears it and writes a new owner into it, kept in the
 * session too; nothing is read or written unless the two match, so a clear that failed (or a session from before) reads
 * nothing, however often the app restarts.
 */

type Saved<T> = { at: number; data: T };
export type Cached<T> = Saved<T>;

/** How many things are kept (lists and conversations), the oldest written going first; one bigger than `MOST_BYTES` isn't. */
export const MOST_KEPT = 60;
export const MOST_BYTES = 512 * 1024;
const ORDER = "order";

let storage: SQLiteStorage | null = null;
const store = () => (storage ??= new SQLiteStorage("offline.db"));
// Bumped when it's all forgotten: a load that started before then isn't written after.
let generation = 0;

/** The keys: the server and project, then what it is. */
export const inboxKey = (session: { server: string; project?: string }, view: string) => `${session.server}|${session.project ?? ""}|inbox|${view}`;
/** Small and one per account (or project): kept apart from the most kept, never pushed out by lists and conversations. */
const PINNED = "pinned|";
export const projectsKey = (session: { server: string }) => `${PINNED}${session.server}|projects`;
export const viewsKey = (session: { server: string; project?: string }) => `${PINNED}${session.server}|${session.project ?? ""}|views`;
export const conversationKey = (session: { server: string; project?: string }, number: number) => `${session.server}|${session.project ?? ""}|conversation|${number}`;
/** A conversation's Activity, its newest page of all of it (the details sheet's). */
export const activityKey = (session: { server: string; project?: string }, number: number) => `${session.server}|${session.project ?? ""}|activity|${number}`;

/** Who the cache is for: written at sign-in, once it's cleared, and outside what's pushed out. */
const OWNER = `${PINNED}owner`;
const owns = (owner: string | undefined) => {
  try {
    return !!owner && store().getItemSync(OWNER) === owner;
  } catch {
    return false;
  }
};

/**
 * At sign-in: the cache cleared and made this session's, its owner given back for the session to keep. A clear that
 * fails writes no owner, so the session reads nothing kept.
 */
export function startCache(owner: string = randomUUID()) {
  generation++;
  try {
    store().clearSync();
    store().setItemSync(OWNER, owner);
  } catch {}
  return owner;
}

/** Read as a load starts, and given to `keep` with its answer. */
export const cacheGeneration = () => generation;

/** What's kept under `key`, for the session that owns the cache (`owner`, from the session). */
export function cached<T>(key: string, owner: string | undefined): Cached<T> | null {
  if (!owns(owner)) {
    return null;
  }
  try {
    const value = store().getItemSync(key);
    return value ? (JSON.parse(value) as Saved<T>) : null;
  } catch {
    return null;
  }
}

/** Keeps a load's answer, unless everything was forgotten since it started (`since`), or the cache isn't the session's. */
export function keep(key: string, data: unknown, since: number, owner: string | undefined, now = Date.now()) {
  if (since !== generation || !owns(owner)) {
    return;
  }
  try {
    const value = JSON.stringify({ at: now, data } satisfies Saved<unknown>);
    if (value.length > MOST_BYTES) {
      return;
    }
    const kv = store();
    if (key.startsWith(PINNED)) {
      kv.setItemSync(key, value);
      return;
    }
    const order = [key, ...(JSON.parse(kv.getItemSync(ORDER) ?? "[]") as string[]).filter((k) => k !== key)];
    order.slice(MOST_KEPT).forEach((old) => kv.removeItemSync(old));
    kv.setItemSync(key, value);
    kv.setItemSync(ORDER, JSON.stringify(order.slice(0, MOST_KEPT)));
  } catch {
    // A phone out of space reads what it has.
  }
}

/** Signing out (or the server ending the session) leaves nothing of it on the phone. */
export function forgetCached() {
  generation++;
  try {
    store().clearSync();
  } catch {}
}

/** Whether a load failed for want of a connection (the API's words for it), rather than the server's answer. */
export const isOffline = (error: unknown) => (error as { code?: string } | null)?.code === "unreachable";

/** The time now, moved on every minute: the Inbox's ages and the offline note move on while nothing else changes. */
export function useMinutes() {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const tick = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(tick);
  }, []);
  return [now, setNow] as const;
}

/** The quiet note over what was kept: "Offline · updated 5 minutes ago". */
export const offlineNote = (at: number, now = Date.now()) => `Offline · updated ${spokenAgeOf(new Date(at).toISOString(), now)}`;
