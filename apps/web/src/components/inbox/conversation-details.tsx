"use client";

import { PanelRightCloseIcon, PanelRightOpenIcon } from "lucide-react";
import { cn } from "cn";
import { type ReactNode, useLayoutEffect, useState, useSyncExternalStore } from "react";

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
 * is a sheet. `hidden`: the cookie, as the page read it.
 *
 * Its room is kept from the first render wherever the header's actions are in the top bar, so the buttons beside it
 * never move as the page's scripts start: there and without the column, it's there but unseen (and not in the
 * keyboard's way). Whether the column is there is checked before the page is painted (a layout effect); until then
 * it shows, as it does at most widths.
 */
export function DetailsToggle({ hidden: server }: { hidden: boolean }) {
  const hidden = useHidden(server);
  const [beside, setBeside] = useState<boolean | null>(null);
  useLayoutEffect(() => {
    const conversation = document.getElementById("conversation");
    const layout = conversation?.firstElementChild;
    if (!conversation || !layout) {
      return;
    }
    const check = () => setBeside(getComputedStyle(layout).display === "grid");
    check();
    const observer = new ResizeObserver(check);
    observer.observe(conversation);
    return () => observer.disconnect();
  }, []);
  const label = hidden ? "Show details" : "Hide details";
  return (
    <Button
      variant="ghost"
      size="icon-sm"
      // On phones the actions are a menu: not in it at all.
      className={cn("phonebar:hidden", beside === false && "invisible")}
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
