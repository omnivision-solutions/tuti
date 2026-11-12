"use client";

import { cn } from "cn";
import { BookOpenIcon, EllipsisIcon, ExternalLinkIcon } from "lucide-react";
import { createContext, type ReactNode, type RefObject, useContext, useEffect, useRef, useState } from "react";
import { IconTooltip } from "@/components/icon-tooltip";
import { Button, buttonVariants } from "@/components/ui/button";

import { PaneHeader } from "@/components/pane";

const DocsMoreFocus = createContext<RefObject<HTMLButtonElement | null> | undefined>(undefined);
export const useDocsMoreFocus = () => useContext(DocsMoreFocus);

export function DocsMore({ children, className }: { children: ReactNode; className?: string }) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const toggle = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(false);
        toggle.current?.focus();
        event.stopPropagation();
      }
    };
    document.addEventListener("pointerdown", outside);
    root.current?.addEventListener("keydown", escape);
    const element = root.current;
    return () => {
      document.removeEventListener("pointerdown", outside);
      element?.removeEventListener("keydown", escape);
    };
  }, [open]);
  return (
    <div ref={root} className={cn("docs-more relative text-[13px]", className)}>
      <IconTooltip label="More actions"><Button ref={toggle} type="button" variant="outline" size="icon-sm" aria-label="More actions" aria-expanded={open} onClick={() => setOpen(!open)}>
        <EllipsisIcon className="size-4" />
      </Button></IconTooltip>
      <div
        hidden={!open}
        className="docs-more-menu absolute right-[0] top-[100%] z-30 flex flex-col items-stretch w-55 p-1.25 border border-border rounded-[10px] bg-popover shadow-[0_10px_32px_color-mix(in_oklch,_var(--foreground)_14%,_transparent)] [&_>_*]:justify-start"
        onClick={(event) => {
          if ((event.target as Element).closest("a, button")) {
            setOpen(false);
            toggle.current?.focus();
          }
        }}
      >
        <DocsMoreFocus.Provider value={toggle}>{children}</DocsMoreFocus.Provider>
      </div>
    </div>
  );
}

/** Opens the Docs tree as a sheet where it isn't beside the page (DocsWorkspace provides it). */
export const DocsBrowse = createContext<{ open: boolean; browse: () => void } | null>(null);

/** Every Docs header's first action under 61rem of the shell, where the tree isn't beside the page: it opens as a sheet. */
export function DocsBrowseButton() {
  const docs = useContext(DocsBrowse);
  if (!docs) return null;
  return (
    <IconTooltip label="Browse docs">
      <Button type="button" variant="outline" size="icon-sm" aria-label="Browse docs" aria-expanded={docs.open} onClick={docs.browse} className="@min-[61rem]/app:hidden">
        <BookOpenIcon />
      </Button>
    </IconTooltip>
  );
}

/**
 * A Docs page's pane header (PaneHeader): its title (an icon before it), a line on it, the way back, `filters` (its
 * views as pills), its actions and "More actions". It stays at the top of the page's pane as the page scrolls.
 */
export function DocsPageHeader({
  title,
  description,
  back,
  filters,
  actions,
  more,
  icon,
  titleInForm,
  helpCenter,
}: {
  title: ReactNode;
  description?: ReactNode;
  back?: { href: string; label: ReactNode };
  filters?: ReactNode;
  actions?: ReactNode;
  more?: ReactNode;
  icon?: ReactNode;
  /** An editor whose title field shows the title (PaneHeader). */
  titleInForm?: boolean;
  /** The page on the help center: "View on help center" in words, under More actions on phones. */
  helpCenter?: string;
}) {
  return (
    <div data-slot="docs-page-header" className="docs-page-header sticky top-0 z-20 -mx-(--docs-pad) bg-card">
      <PaneHeader
        title={
          <>
            {icon && <span aria-hidden className="mr-2 inline-flex align-[-0.1em] text-muted-foreground [&_svg]:size-4.5">{icon}</span>}
            {title}
          </>
        }
        description={description}
        titleInForm={titleInForm}
        back={back}
        filters={filters}
        actions={
          <>
            <DocsBrowseButton />
            {helpCenter && (
              <a href={helpCenter} target="_blank" rel="noreferrer" className={buttonVariants({ variant: "outline", className: "docs-live-link @max-[48rem]/app:hidden" })}>
                <ExternalLinkIcon />
                View on help center
              </a>
            )}
            {actions}
            {(more || helpCenter) && (
              // With only the help center in it, the menu is for phones.
              <DocsMore className={more ? undefined : "@min-[48rem]/app:hidden"}>
                {helpCenter && (
                  <a href={helpCenter} target="_blank" rel="noreferrer" className={buttonVariants({ variant: "ghost", size: "sm", className: "@min-[48rem]/app:hidden" })}>
                    <ExternalLinkIcon />
                    View on help center
                  </a>
                )}
                {more}
              </DocsMore>
            )}
          </>
        }
      />
    </div>
  );
}
