"use client";

import { cn } from "cn";
import { EllipsisIcon } from "lucide-react";
import { usePathname } from "next/navigation";
import { type ReactNode, useEffect, useId, useRef, useState } from "react";

import { Button } from "@/components/ui/button";

/**
 * A page's actions (PageHeader's): `children` are the ones it uses most, `more` the others. From
 * tablet width up the first are in the top bar and `more` behind its "More actions" button; in the
 * app on phones, that button (in the bar) opens all of them as a menu. They're hidden while it's
 * closed, not taken away, so a dialog one of them opened (Settings, Delete) stays open when it closes.
 */
export function PageActions({ children, more }: { children?: ReactNode; more?: ReactNode }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const moreId = useId();
  const ref = useRef<HTMLDivElement>(null);
  // Its button on phones, and the one in the bar's row (with `more`) from tablet width up: whichever shows.
  const phoneToggle = useRef<HTMLButtonElement>(null);
  const barToggle = useRef<HTMLButtonElement>(null);
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
        [phoneToggle.current, barToggle.current].find((toggle) => toggle?.checkVisibility())?.focus();
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

  const toggleProps = { variant: "ghost", size: "icon", "aria-label": "More actions", "aria-expanded": open, onClick: () => setOpen(!open) } as const;
  return (
    <div ref={ref} className="contents">
      <Button
        ref={phoneToggle}
        {...toggleProps}
        aria-controls={id}
        className="hidden phonebar:fixed phonebar:top-2 phonebar:right-2 phonebar:z-20 phonebar:inline-flex"
      >
        <EllipsisIcon aria-hidden />
      </Button>
      <div
        id={id}
        // Picking one closes it; a button that opens a menu leaves it open, as the menu hangs from it.
        onClick={(event) => (event.target as Element).closest('a, button:not([aria-haspopup="menu"]):not([aria-label="More actions"])') && setOpen(false)}
        className={cn(
          "flex max-w-full shrink-0 flex-wrap items-center gap-2 topbar:relative topbar:flex-nowrap",
          "phonebar:fixed phonebar:top-12 phonebar:right-2 phonebar:z-30 phonebar:w-60 phonebar:flex-col phonebar:items-stretch phonebar:gap-1 phonebar:rounded-lg phonebar:border phonebar:bg-popover phonebar:p-1 phonebar:shadow-md phonebar:*:justify-start",
          !open && "phonebar:hidden",
        )}
      >
        {children}
        {more && (
          <>
            <Button ref={barToggle} {...toggleProps} aria-controls={moreId} className="hidden topbar:inline-flex">
              <EllipsisIcon aria-hidden />
            </Button>
            {/* Under the bar's button from tablet width up; on phones, part of the menu above. */}
            <div
              id={moreId}
              className={cn(
                "contents phonebar:*:justify-start topbar:absolute topbar:top-full topbar:right-0 topbar:z-30 topbar:mt-1 topbar:w-56 topbar:flex-col topbar:items-stretch topbar:gap-1 topbar:rounded-lg topbar:border topbar:bg-popover topbar:p-1 topbar:shadow-md topbar:*:justify-start",
                open ? "topbar:flex" : "topbar:hidden",
              )}
            >
              {more}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
