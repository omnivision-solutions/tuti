"use client";

import { BookOpenIcon, EllipsisIcon, ExternalLinkIcon } from "lucide-react";
import { createContext, type ReactNode, type RefObject, useCallback, useContext, useRef, useState } from "react";
import { IconTooltip } from "@/components/icon-tooltip";
import { Button, buttonVariants } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";

import { PaneHeader } from "@/components/pane";

const DocsMoreFocus = createContext<RefObject<HTMLButtonElement | null> | undefined>(undefined);
export const useDocsMoreFocus = () => useContext(DocsMoreFocus);

/** A Docs header's "More actions": the shared menu, kept mounted so its rows' dialogs outlive it closing (as ConversationMore). */
export function DocsMore({ children, className, onOpenChange }: { children: ReactNode; className?: string; onOpenChange?: (open: boolean) => void }) {
  const toggle = useRef<HTMLButtonElement>(null);
  return (
    <DropdownMenu modal={false} onOpenChange={onOpenChange}>
      <IconTooltip label="More actions">
        <DropdownMenuTrigger render={<Button ref={toggle} type="button" variant="outline" size="icon-sm" aria-label="More actions" className={className} />}>
          <EllipsisIcon className="size-4" />
        </DropdownMenuTrigger>
      </IconTooltip>
      <DropdownMenuContent align="end" keepMounted className="w-auto min-w-44">
        <DocsMoreFocus.Provider value={toggle}>{children}</DocsMoreFocus.Provider>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** Opens the Docs tree as a sheet where it isn't beside the page (DocsWorkspace provides it). */
export const DocsBrowse = createContext<{ open: boolean; browse: () => void } | null>(null);

/** Every Docs header's first action under 61rem of the shell, where the tree isn't beside the page: it opens as a sheet. */
function DocsBrowseButton() {
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
  /** The page on the help center: "View on help center" in words, under More actions in a narrow pane. */
  helpCenter?: string;
}) {
  // Its height (one row, or two with the pills), for the pane it sticks to: what's focused or scrolled to clears it.
  const measure = useCallback((header: HTMLDivElement | null) => {
    const pane = header?.parentElement;
    if (!header || !pane) return;
    const sized = new ResizeObserver(() => pane.style.setProperty("--docs-header-height", `${header.offsetHeight}px`));
    sized.observe(header);
    return () => {
      sized.disconnect();
      pane.style.removeProperty("--docs-header-height");
    };
  }, []);
  // The menu opens outside the pane, so the pane's width can't hide its "View on help center": it's there when the header's own is hidden.
  const liveLink = useRef<HTMLAnchorElement>(null);
  const [inMenu, setInMenu] = useState(true);
  return (
    // What it shows follows its page's pane (`@container/docs-page`), not the window: the tree's width counts. The pills get a
    // row of their own under the title, the description goes in a narrow pane, and so do the actions' words.
    <div ref={measure} data-slot="docs-page-header" className="docs-page-header sticky top-0 z-20 -mx-(--docs-pad) bg-card @max-[52rem]/docs-page:[&_h1+p]:hidden">
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
        actions={
          <>
            <DocsBrowseButton />
            {helpCenter && (
              <a ref={liveLink} href={helpCenter} target="_blank" rel="noreferrer" className={buttonVariants({ variant: "outline", className: "docs-live-link @max-[44rem]/docs-page:hidden" })}>
                <ExternalLinkIcon />
                View on help center
              </a>
            )}
            {actions}
            {(more || helpCenter) && (
              // With only the help center in it, the menu is for phones.
              <DocsMore className={more ? undefined : "@min-[44rem]/docs-page:hidden"} onOpenChange={(open) => open && setInMenu(!liveLink.current?.checkVisibility())}>
                {helpCenter && inMenu && (
                  <DropdownMenuItem render={<a href={helpCenter} target="_blank" rel="noreferrer" />}>
                    <ExternalLinkIcon />
                    View on help center
                  </DropdownMenuItem>
                )}
                {more}
              </DocsMore>
            )}
          </>
        }
      />
      {filters && <div className="flex min-w-0 border-b px-3 py-2 @min-[48rem]/app:px-5">{filters}</div>}
    </div>
  );
}
