"use client";

import { EllipsisIcon, SearchIcon } from "lucide-react";
import { type ReactNode, useEffect, useId, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import { OPEN_COMMAND_MENU } from "@/lib/command-menu-event";
import { Button } from "@/components/ui/button";

/** Keeps dialog actions mounted when their menu closes, so the dialog can finish and return focus. */
export function ConversationMore({ children, label = "More actions" }: { children: ReactNode; label?: string }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const id = useId();
  const pathname = usePathname();
  const [place, setPlace] = useState(pathname);
  if (place !== pathname) {
    setPlace(pathname);
    setOpen(false);
  }
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      if (!ref.current?.contains(event.target as Node) && !(event.target as Element).closest('[role="menu"]')) setOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        trigger.current?.focus();
        setOpen(false);
      }
    };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("keydown", escape);
    };
  }, [open]);
  return (
    <div ref={ref} className="inbox-more relative">
      <Button ref={trigger} variant="ghost" size="icon-sm" aria-label={label} aria-expanded={open} aria-controls={id} onClick={() => setOpen(!open)}>
        <EllipsisIcon />
      </Button>
      <div
        id={id}
        hidden={!open}
        className="inbox-more-menu absolute top-full right-0 z-40 w-56 rounded-[0.625rem] border border-border bg-popover p-1 shadow-inbox [&:not([hidden])]:flex [&:not([hidden])]:flex-col [&:not([hidden])]:gap-1 [&>button]:justify-start"
        onClick={(event) => {
          if ((event.target as Element).closest('button:not([aria-haspopup="menu"])')) {
            trigger.current?.focus();
            setOpen(false);
          }
        }}
      >
        {children}
      </div>
    </div>
  );
}

/** Opens the existing project search without leaving the Inbox. */
export function InboxSearchButton() {
  return (
    <Button variant="ghost" size="icon-sm" aria-label="Search project" onClick={() => window.dispatchEvent(new Event(OPEN_COMMAND_MENU))}>
      <SearchIcon />
    </Button>
  );
}
