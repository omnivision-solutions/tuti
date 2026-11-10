"use client";

import { cn } from "cn";
import { PanelLeftCloseIcon, PanelLeftOpenIcon } from "lucide-react";
import { useEffect, useSyncExternalStore } from "react";

import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { DOCS_TREE_FOLDED_ATTRIBUTE, DOCS_TREE_FOLDED_KEY } from "@/lib/docs-tree-fold";

/**
 * The docs tree's fold, from laptop width up: at the top of the tree it folds it to a rail (the page takes the room);
 * on the rail it opens it again. Remembered per browser, on every Docs page. The attribute on <html> (the app
 * layout's script sets it before the page shows) is the one place it's kept.
 */
export function DocsTreeFold({ open, className }: { /** The rail's button (it opens the tree), or the tree's (it folds it). */ open: boolean; className?: string }) {
  // Entering the app from marketing or sign-in mounts its inline script on the client, where it does not run.
  useEffect(() => {
    try {
      document.documentElement.toggleAttribute(DOCS_TREE_FOLDED_ATTRIBUTE, localStorage.getItem(DOCS_TREE_FOLDED_KEY) === "1");
    } catch {
      // Storage blocked: keep this visit's fold.
    }
  }, []);
  const folded = useSyncExternalStore(subscribe, () => document.documentElement.hasAttribute(DOCS_TREE_FOLDED_ATTRIBUTE), () => false);
  const set = (next: boolean) => {
    document.documentElement.toggleAttribute(DOCS_TREE_FOLDED_ATTRIBUTE, next);
    // This button is hidden with what it folds or opens: the keyboard's focus goes to the one that undoes it.
    document.querySelector<HTMLElement>(`[data-docs-tree-fold="${next ? "open" : "fold"}"]`)?.focus();
    try {
      if (next) localStorage.setItem(DOCS_TREE_FOLDED_KEY, "1");
      else localStorage.removeItem(DOCS_TREE_FOLDED_KEY);
    } catch {
      // Storage blocked: folded for this visit only.
    }
  };
  const label = open ? "Show the docs tree" : "Hide the docs tree";
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={label}
            aria-controls="docs-tree"
            data-docs-tree-fold={open ? "open" : "fold"}
            aria-expanded={!folded}
            onClick={() => set(!open)}
            // Quiet: a ghost button's open-menu fill (aria-expanded) isn't for a fold.
            className={cn("text-muted-foreground aria-expanded:bg-transparent aria-expanded:text-muted-foreground hover:aria-expanded:bg-muted hover:aria-expanded:text-foreground", className)}
          />
        }
      >
        {open ? <PanelLeftOpenIcon aria-hidden /> : <PanelLeftCloseIcon aria-hidden />}
      </TooltipTrigger>
      <TooltipContent side="right">{label}</TooltipContent>
    </Tooltip>
  );
}

function subscribe(changed: () => void) {
  const observer = new MutationObserver(changed);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: [DOCS_TREE_FOLDED_ATTRIBUTE] });
  return () => observer.disconnect();
}
