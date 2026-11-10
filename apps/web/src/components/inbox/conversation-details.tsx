"use client";

import { PanelRightCloseIcon, PanelRightOpenIcon } from "lucide-react";
import { type ReactNode, useEffect, useState, useSyncExternalStore } from "react";

import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { DETAILS_HIDDEN_COOKIE } from "@/lib/inbox-details";

const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};
const hiddenNow = () => document.cookie.split("; ").includes(`${DETAILS_HIDDEN_COOKIE}=1`);
const useHidden = (server: boolean) => useSyncExternalStore(subscribe, hiddenNow, () => server);
const OPEN_DETAILS = "tuti:conversation-details";
const wide = () => window.matchMedia("(min-width: 1200px)").matches;
const subscribeWidth = (listener: () => void) => {
  const query = window.matchMedia("(min-width: 1200px)");
  query.addEventListener("change", listener);
  return () => query.removeEventListener("change", listener);
};

export function ConversationDetails({ hidden, children }: { hidden: boolean; children: ReactNode }) {
  return (
    <div className="inbox-thread" data-details={useHidden(hidden) ? "hidden" : "shown"}>
      {children}
    </div>
  );
}

/** The same details and controls, in a card on laptops and a sheet on smaller screens. */
export function DetailsPanel({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const beside = useSyncExternalStore(subscribeWidth, wide, () => true);
  useEffect(() => {
    const show = () => setOpen(true);
    window.addEventListener(OPEN_DETAILS, show);
    return () => window.removeEventListener(OPEN_DETAILS, show);
  }, []);
  return (
    <>
      <aside id="conversation-details" aria-label="Conversation details" className="inbox-details inbox-surface">
        <h2>Conversation details</h2>
        <div className="inbox-details-scroll">{children}</div>
      </aside>
      <Sheet open={open && !beside} onOpenChange={setOpen}>
        <SheetContent side="bottom" className="inbox-details-sheet">
          <div className="inbox-sheet-handle" />
          <SheetHeader>
            <SheetTitle>Conversation details</SheetTitle>
          </SheetHeader>
          <div className="inbox-details-scroll">{children}</div>
        </SheetContent>
      </Sheet>
    </>
  );
}

export function DetailsToggle({ hidden: server }: { hidden: boolean }) {
  const hidden = useHidden(server);
  const beside = useSyncExternalStore(subscribeWidth, wide, () => true);
  const label = !beside || hidden ? "Show details" : "Hide details";
  return (
    <Button
      variant="ghost"
      size="icon-sm"
      aria-label={label}
      title={label}
      aria-expanded={beside && !hidden}
      aria-controls={beside ? "conversation-details" : undefined}
      onClick={() => {
        if (!beside) {
          window.dispatchEvent(new Event(OPEN_DETAILS));
          return;
        }
        document.cookie = hidden ? `${DETAILS_HIDDEN_COOKIE}=; path=/; max-age=0` : `${DETAILS_HIDDEN_COOKIE}=1; path=/; max-age=31536000; samesite=lax`;
        listeners.forEach((listener) => listener());
      }}
    >
      {!beside || hidden ? <PanelRightOpenIcon /> : <PanelRightCloseIcon />}
    </Button>
  );
}
