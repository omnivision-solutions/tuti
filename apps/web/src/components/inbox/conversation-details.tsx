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
// CSS decides from the actual Inbox container; the toggle and sheet use the same decision.
const wide = () => {
  const workspace = document.querySelector(".inbox-workspace");
  return !!workspace && getComputedStyle(workspace).getPropertyValue("--inbox-details-beside").trim() === "1";
};
const subscribeWidth = (listener: () => void) => {
  const sizes = new ResizeObserver(listener);
  const workspace = document.querySelector(".inbox-workspace");
  if (workspace) sizes.observe(workspace);
  let fontSize = document.documentElement.style.fontSize;
  const font = new MutationObserver((records) => {
    const next = document.documentElement.style.fontSize;
    // Width preference writes do not change whether details fit.
    if (next === fontSize && records.every((record) => record.attributeName !== "class")) return;
    fontSize = next;
    listener();
  });
  font.observe(document.documentElement, { attributes: true, attributeFilter: ["style", "class"] });
  return () => {
    sizes.disconnect();
    font.disconnect();
  };
};

export function ConversationDetails({ hidden, children }: { hidden: boolean; children: ReactNode }) {
  return (
    <div className="inbox-thread group/thread grid min-h-0 min-w-0 flex-1 grid-cols-[minmax(0,1fr)] @min-[calc(780px_+_16.5rem)]/inbox:grid-cols-[minmax(480px,1fr)_minmax(15rem,18.75rem)] grid-rows-[auto_minmax(0,1fr)] gap-x-3 data-[details=hidden]:grid-cols-[minmax(0,1fr)] has-[>.inbox-overview]:flex" data-details={useHidden(hidden) ? "hidden" : "shown"}>
      {children}
    </div>
  );
}

/** The same details and controls, in a card on laptops and a sheet on smaller screens. */
export function DetailsPanel({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const beside = useSyncExternalStore(subscribeWidth, wide, () => true);
  // Reset during the breakpoint render so narrowing cannot resurrect a sheet from the previous phone view.
  if (beside && open) setOpen(false);
  useEffect(() => {
    const show = () => setOpen(true);
    window.addEventListener(OPEN_DETAILS, show);
    return () => window.removeEventListener(OPEN_DETAILS, show);
  }, []);
  return (
    <>
      <aside id="conversation-details" aria-label="Conversation details" className="group/details inbox-details inbox-surface col-start-2 row-span-2 row-start-1 hidden @min-[calc(780px_+_16.5rem)]/inbox:flex flex-col overflow-hidden group-data-[details=hidden]/thread:hidden min-w-0 min-h-0 bg-card shadow-inbox rounded-2xl max-md:rounded-xl">
        <h2 className="px-4.5 pt-5 pb-3 font-sans text-sm leading-[normal] font-semibold">Conversation details</h2>
        <div className="inbox-details-scroll min-h-0 overflow-y-auto px-4.5 pb-4.5 [scrollbar-width:thin] group-[.inbox-details-sheet]/details:px-5">{children}</div>
      </aside>
      <Sheet open={open && !beside} onOpenChange={setOpen}>
        <SheetContent overlayClassName="bg-(--inbox-overlay) backdrop-filter-none!" side="bottom" className="inbox-details-sheet group/details inset-x-2! top-17.5 bottom-2! h-auto gap-0 rounded-t-3xl rounded-b-xl border-0! bg-card [--card:var(--inbox-surface)] dark:[--muted-foreground:var(--inbox-muted)] dark:[--secondary:var(--inbox-secondary)] [&>[data-slot=sheet-close]]:top-5 [&>[data-slot=sheet-close]]:right-4.5">
          <div className="inbox-sheet-handle mx-auto mt-2.5 h-1 w-8.5 flex-none rounded-sm bg-input" />
          <SheetHeader className="min-h-12 justify-center px-4.5 pt-2 pb-2.5">
            <SheetTitle className="font-sans text-[1.0625rem] leading-[normal] font-semibold">Conversation details</SheetTitle>
          </SheetHeader>
          <div className="inbox-details-scroll min-h-0 overflow-y-auto px-4.5 pb-4.5 [scrollbar-width:thin] group-[.inbox-details-sheet]/details:px-5">{children}</div>
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
      aria-expanded={beside ? !hidden : undefined}
      aria-haspopup={beside ? undefined : "dialog"}
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
