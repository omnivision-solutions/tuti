"use client";

import { cn } from "cn";
import { EllipsisIcon } from "lucide-react";
import { usePathname } from "next/navigation";
import { type ReactNode, useEffect, useId, useRef, useState } from "react";

import { Button } from "@/components/ui/button";

/**
 * A page's actions (PageHeader's). From tablet width up they're in the top bar; in the app on phones,
 * a "More actions" button in the bar opens them as a menu. They're hidden while it's closed, not
 * taken away, so a dialog one of them opened (Settings, Delete) stays open when the menu closes.
 */
export function PageActions({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const ref = useRef<HTMLDivElement>(null);
  const toggle = useRef<HTMLButtonElement>(null);
  // A new page closes it.
  const pathname = usePathname();
  const [shown, setShown] = useState(pathname);
  if (shown !== pathname) {
    setShown(pathname);
    setOpen(false);
  }

  useEffect(() => {
    if (!open) {
      return;
    }
    // A press outside it (but not in a menu one of its actions opened) or Escape closes it.
    const outside = (event: PointerEvent) => {
      const target = event.target as Element;
      if (!ref.current?.contains(target) && !target.closest?.('[role="menu"]')) {
        setOpen(false);
      }
    };
    // Picking from such a menu closes it too, once the pick is made.
    const picked = (event: MouseEvent) => (event.target as Element).closest?.('[role="menuitem"]') && setOpen(false);
    // Escape from one of its actions takes focus back to its button, as they're about to be hidden.
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") {
        return;
      }
      if (ref.current?.contains(document.activeElement)) {
        toggle.current?.focus();
      }
      setOpen(false);
    };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("click", picked);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("click", picked);
      document.removeEventListener("keydown", escape);
    };
  }, [open]);

  return (
    <div ref={ref} className="contents">
      <Button
        ref={toggle}
        variant="ghost"
        size="icon"
        aria-label="More actions"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen(!open)}
        className="hidden phonebar:fixed phonebar:top-2 phonebar:right-2 phonebar:z-20 phonebar:inline-flex"
      >
        <EllipsisIcon aria-hidden />
      </Button>
      <div
        id={id}
        // Picking one closes it; a button that opens a menu leaves it open, as the menu hangs from it.
        onClick={(event) => (event.target as Element).closest('a, button:not([aria-haspopup="menu"])') && setOpen(false)}
        className={cn(
          "flex max-w-full shrink-0 flex-wrap items-center gap-2 topbar:flex-nowrap",
          "phonebar:fixed phonebar:top-12 phonebar:right-2 phonebar:z-30 phonebar:w-60 phonebar:flex-col phonebar:items-stretch phonebar:gap-1 phonebar:rounded-lg phonebar:border phonebar:bg-popover phonebar:p-1 phonebar:shadow-md phonebar:*:justify-start",
          !open && "phonebar:hidden",
        )}
      >
        {children}
      </div>
    </div>
  );
}
