"use client";

import { EllipsisIcon } from "lucide-react";
import { type ReactNode, useEffect, useId, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import { Button } from "@/components/ui/button";

/** Keeps dialog actions mounted when their menu closes, so the dialog can finish and return focus. */
export function ConversationMore({ children }: { children: ReactNode }) {
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
    <div ref={ref} className="inbox-more">
      <Button ref={trigger} variant="ghost" size="icon-sm" aria-label="More actions" aria-expanded={open} aria-controls={id} onClick={() => setOpen(!open)}>
        <EllipsisIcon />
      </Button>
      <div
        id={id}
        hidden={!open}
        className="inbox-more-menu"
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
