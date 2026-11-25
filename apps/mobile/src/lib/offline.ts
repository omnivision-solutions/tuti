import { SQLiteStorage } from "expo-sqlite/kv-store";
import { useEffect, useState } from "react";

import { spokenAgeOf } from "./inbox";

/**
 * What was last loaded, kept on the phone to be read with no connection: the Inbox's views and lists (per project and
 * view) and the conversations opened. Expo's SQLite key-value store, a database of its own. One account's at a time:
 * signing out, or a session the server ended, forgets it all (`forgetCached`), so whoever signs in next never sees the
 * last one's customers.
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
// A clear that failed: nothing is read till one succeeds, so a failed clear never hands one account's rows to the next.
let unreadable = false;

/** The keys: the server and project, then what it is. */
export const inboxKey = (session: { server: string; project?: string }, view: string) => `${session.server}|${session.project ?? ""}|inbox|${view}`;
/** Small and one per account (or project): kept apart from the most kept, never pushed out by lists and conversations. */
const PINNED = "pinned|";
export const projectsKey = (session: { server: string }) => `${PINNED}${session.server}|projects`;
export const viewsKey = (session: { server: string; project?: string }) => `${PINNED}${session.server}|${session.project ?? ""}|views`;
export const conversationKey = (session: { server: string; project?: string }, number: number) => `${session.server}|${session.project ?? ""}|conversation|${number}`;

/** Read as a load starts, and given to `keep` with its answer. */
export const cacheGeneration = () => generation;

export function cached<T>(key: string): Cached<T> | null {
  if (unreadable) {
    return null;
  }
  try {
    const value = store().getItemSync(key);
    return value ? (JSON.parse(value) as Saved<T>) : null;
  } catch {
    return null;
  }
}

/** Keeps a load's answer, unless everything was forgotten since it started (`since`). */
export function keep(key: string, data: unknown, since: number, now = Date.now()) {
  if (since !== generation) {
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
    unreadable = false;
  } catch {
    unreadable = true;
  }
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
