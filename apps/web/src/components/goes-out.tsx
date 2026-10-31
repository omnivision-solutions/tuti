"use client";

/** When a scheduled update goes out, in the reader's own time: "today at 3:10 pm", "tomorrow at 9:00 am", "on Mon 3 Nov at …". */
export function goesOutAt(at: Date, now = new Date()): string {
  const midnight = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  if (at.getTime() <= now.getTime()) {
    return "in a moment";
  }
  const days = Math.round((midnight(at) - midnight(now)) / 86_400_000);
  const time = at.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" }).toLowerCase();
  const day = days === 0 ? "today" : days === 1 ? "tomorrow" : `on ${at.toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" })}`;
  return `${day} at ${time}`;
}

/** "Goes out tomorrow at 3:10 pm" (`prefix`, then when), in the reader's time zone (the server's may differ). */
export function GoesOut({ at, prefix = "Goes out" }: { at: string; prefix?: string }) {
  return <span suppressHydrationWarning>{`${prefix} ${goesOutAt(new Date(at))}`}</span>;
}
