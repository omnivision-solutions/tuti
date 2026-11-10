"use client";

import { useSyncExternalStore } from "react";

const subscribe = () => () => {};

/** The surrounding editor renders its slots before hydration; the server has no DOM. */
export function useEditorSlot(id: string | undefined) {
  return useSyncExternalStore(
    subscribe,
    () => (id ? document.getElementById(id) : null),
    () => null,
  );
}
