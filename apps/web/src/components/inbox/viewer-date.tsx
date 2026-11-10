"use client";

import { useSyncExternalStore } from "react";

const subscribe = () => () => {};

/** Like MessageDay, wait for hydration: only the browser knows the viewer's time zone. */
export function ViewerDate({ at, year = false }: { at: string; year?: boolean }) {
  const label = useSyncExternalStore(subscribe, () => new Date(at).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "long",
    ...(year ? { year: "numeric" } : {}),
  }), () => null);
  return <time dateTime={at}>{label}</time>;
}
