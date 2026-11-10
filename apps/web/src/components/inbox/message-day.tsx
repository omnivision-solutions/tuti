"use client";

import { useSyncExternalStore } from "react";
import { conversationDay, conversationDayKey } from "@/lib/format";

const everyMinute = (changed: () => void) => {
  const timer = setInterval(changed, 60_000);
  return () => clearInterval(timer);
};

/** The server cannot know the viewer's day: fill it in after hydration, as GoesOut does. */
export function MessageDay({ at, previous }: { at: string; previous?: string }) {
  const label = useSyncExternalStore(everyMinute, () => {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const date = new Date(at);
    if (previous && conversationDayKey(date, zone) === conversationDayKey(new Date(previous), zone)) return null;
    return conversationDay(date, zone);
  }, () => null);
  return label && <p className="inbox-day mb-2.5 pt-0.5 pb-3 text-center text-xs leading-normal text-muted-foreground">{label}</p>;
}
