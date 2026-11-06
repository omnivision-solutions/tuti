"use client";

import { PanelRightCloseIcon, PanelRightOpenIcon } from "lucide-react";
import { type ReactNode, useEffect, useState, useSyncExternalStore } from "react";

import { Button } from "@/components/ui/button";
import { DETAILS_HIDDEN_COOKIE } from "@/lib/inbox-details";

const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};
const hiddenNow = () => document.cookie.split("; ").includes(`${DETAILS_HIDDEN_COOKIE}=1`);
/** Whether it's hidden: the cookie, or on the server (and while the page hydrates) what the page read from it. */
const useHidden = (server: boolean) => useSyncExternalStore(subscribe, hiddenNow, () => server);

/**
 * What a conversation's page shows in (around its header and `#conversation`): `data-details="hidden"` while the column
 * beside the messages is hidden, for its classes (`in-data-[details=hidden]:`). `hidden`: the cookie, as the page read it.
 */
export function ConversationDetails({ hidden, children }: { hidden: boolean; children: ReactNode }) {
  return (
    <div className="contents" data-details={useHidden(hidden) ? "hidden" : "shown"}>
      {children}
    </div>
  );
}

/**
 * Hides and shows the column beside the messages (`#conversation-details`), for every conversation in this browser. Only
 * where that column is there: its pane wide enough for it (`#conversation`'s grid, an @container), not where the person
 * is a sheet.
 */
export function DetailsToggle() {
  const hidden = useHidden(false);
  const [beside, setBeside] = useState(false);
  useEffect(() => {
    const conversation = document.getElementById("conversation");
    const layout = conversation?.firstElementChild;
    if (!conversation || !layout) {
      return;
    }
    const observer = new ResizeObserver(() => setBeside(getComputedStyle(layout).display === "grid"));
    observer.observe(conversation);
    return () => observer.disconnect();
  }, []);
  if (!beside) {
    return null;
  }
  const label = hidden ? "Show details" : "Hide details";
  return (
    <Button
      variant="ghost"
      size="icon-sm"
      aria-label={label}
      title={label}
      aria-expanded={!hidden}
      aria-controls="conversation-details"
      onClick={() => {
        document.cookie = hidden ? `${DETAILS_HIDDEN_COOKIE}=; path=/; max-age=0` : `${DETAILS_HIDDEN_COOKIE}=1; path=/; max-age=31536000; samesite=lax`;
        listeners.forEach((listener) => listener());
      }}
    >
      {hidden ? <PanelRightOpenIcon /> : <PanelRightCloseIcon />}
    </Button>
  );
}
