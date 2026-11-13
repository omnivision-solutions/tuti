"use client";

import { cn } from "cn";
import { EllipsisIcon } from "lucide-react";
import { usePathname } from "next/navigation";
import { type ReactNode, useEffect, useId, useRef, useState } from "react";

import { Button } from "@/components/ui/button";

/**
 * A page's actions (its pane header's): `children` are the ones it uses most, `more` the others. From
 * tablet width up the first are beside the page's title and `more` behind its "More actions" button; in the
 * app on phones, that button (in the bar) opens all of them as a menu. They're hidden while it's
 * closed, not taken away, so a dialog one of them opened (Settings, Delete) stays open when it closes.
 * `pinned`: on phones the first stay in a bar at the bottom of the screen instead (a main action like Publish, in
 * reach), and the menu has only `more`.
 */
export function PageActions({ children, more, pinned = false }: { children?: ReactNode; more?: ReactNode; pinned?: boolean }) {
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

  const focusToggle = () => [phoneToggle.current, barToggle.current].find((toggle) => toggle?.checkVisibility())?.focus();
  const moreRef = useRef<HTMLDivElement>(null);

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
    // Picking from such a menu closes it too, once the pick is made. On phones that hides the menu's button with it:
    // the keyboard's focus goes back to the button that opened them.
    const picked = (event: MouseEvent) => {
      if ((event.target as Element).closest?.('[role="menuitem"]')) {
        if (phoneToggle.current?.checkVisibility()) {
          focusToggle();
        }
        setOpen(false);
      }
    };
    // Escape from one of its actions takes focus back to its button, as they're about to be hidden.
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") {
        return;
      }
      if (ref.current?.contains(document.activeElement)) {
        focusToggle();
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
        className={cn("hidden", (!pinned || more) && "phonebar:fixed phonebar:top-2 phonebar:right-2 phonebar:z-20 phonebar:inline-flex")}
      >
        <EllipsisIcon aria-hidden />
      </Button>
      <div
        id={id}
        // Picking one closes it; a button that opens a menu leaves it open, as the menu hangs from it. One hidden with it
        // (all of them on phones, `more` from tablet width up) gives the keyboard's focus back to the button that opened it.
        onClick={(event) => {
          const picked = (event.target as Element).closest('a, button:not([aria-haspopup="menu"]):not([aria-label="More actions"])');
          if (!picked) {
            return;
          }
          if (open && (phoneToggle.current?.checkVisibility() || moreRef.current?.contains(picked))) {
            focusToggle();
          }
          setOpen(false);
        }}
        className={cn(
          "flex max-w-full shrink-0 flex-wrap items-center gap-2 topbar:relative topbar:flex-nowrap",
          pinned
            ? "phonebar:contents"
            : "phonebar:fixed phonebar:top-12 phonebar:right-2 phonebar:z-30 phonebar:w-60 phonebar:flex-col phonebar:items-stretch phonebar:gap-1 phonebar:rounded-lg phonebar:border phonebar:bg-popover phonebar:p-1 phonebar:shadow-md phonebar:*:justify-start",
          // In the menu every action is a row alike: Publish's fill and Unpublish's outline are for the bar.
          !pinned && "phonebar:[&>button]:border-transparent phonebar:[&>button]:bg-transparent phonebar:[&>button]:text-foreground phonebar:[&>button]:shadow-none phonebar:[&>button:hover]:bg-accent",
          !open && !pinned && "phonebar:hidden",
        )}
      >
        {pinned ? (
          // The app's page leaves room for it at the bottom (AppShell, data-pinned-actions), and what's focused scrolls
          // above it (globals.css). Its buttons stop left of Tuti's chat launcher, a row more if they need it.
          <div
            data-pinned-actions
            className="contents phonebar:fixed phonebar:inset-x-0 phonebar:bottom-0 phonebar:z-20 phonebar:flex phonebar:justify-end phonebar:gap-2 phonebar:border-t phonebar:bg-background phonebar:px-4 phonebar:pt-3 phonebar:pb-[max(0.75rem,env(safe-area-inset-bottom))] launcher:phonebar:flex-wrap launcher:phonebar:pr-24"
          >
            {children}
          </div>
        ) : (
          children
        )}
        {more && (
          <>
            <Button ref={barToggle} {...toggleProps} aria-controls={moreId} className="hidden topbar:inline-flex">
              <EllipsisIcon aria-hidden />
            </Button>
            {/* Under the bar's button from tablet width up; on phones, part of the menu above. */}
            <div
              ref={moreRef}
              id={moreId}
              className={cn(
                "contents phonebar:*:justify-start topbar:absolute topbar:top-full topbar:right-0 topbar:z-30 topbar:mt-1 topbar:w-56 topbar:flex-col topbar:items-stretch topbar:gap-1 topbar:rounded-lg topbar:border topbar:bg-popover topbar:p-1 topbar:shadow-md topbar:*:justify-start",
                open ? "topbar:flex" : "topbar:hidden",
                // Pinned, on phones it's the menu by itself.
                pinned &&
                  "phonebar:fixed phonebar:top-12 phonebar:right-2 phonebar:z-30 phonebar:w-60 phonebar:flex-col phonebar:items-stretch phonebar:gap-1 phonebar:rounded-lg phonebar:border phonebar:bg-popover phonebar:p-1 phonebar:shadow-md",
                pinned && (open ? "phonebar:flex" : "phonebar:hidden"),
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
