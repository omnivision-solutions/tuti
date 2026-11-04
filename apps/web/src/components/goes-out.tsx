"use client";

import { useSyncExternalStore } from "react";

/**
 * When a scheduled update goes out, in the reader's own time: "today at 3:10 pm", "tomorrow at 9:00 am", "on Mon 3 Nov
 * at …". `past`: when a stopped one would have ("yesterday at …" too).
 */
export function goesOutAt(at: Date, now = new Date(), past = false): string {
  const midnight = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  if (!past && at.getTime() <= now.getTime()) {
    return "in a moment";
  }
  const days = Math.round((midnight(at) - midnight(now)) / 86_400_000);
  const time = at.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" }).toLowerCase();
  const day = days === 0 ? "today" : days === 1 ? "tomorrow" : days === -1 ? "yesterday" : `on ${at.toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" })}`;
  return `${day} at ${time}`;
}

/** A minute's tick: "tomorrow" becomes "today" past midnight, and "in a moment" once it's due. */
const everyMinute = (onChange: () => void) => {
  const timer = setInterval(onChange, 60_000);
  return () => clearInterval(timer);
};

/**
 * "Goes out tomorrow at 3:10 pm" (`prefix`, then when), in the reader's time zone. The server doesn't
 * know it: its HTML says the prefix alone, and the browser fills in the time as it loads.
 */
export function GoesOut({ at, prefix = "Goes out", past = false }: { at: string; prefix?: string; past?: boolean }) {
  const when = useSyncExternalStore(
    everyMinute,
    () => goesOutAt(new Date(at), new Date(), past),
    () => null,
  );
  return <span>{when === null ? prefix : `${prefix} ${when}`}</span>;
}
