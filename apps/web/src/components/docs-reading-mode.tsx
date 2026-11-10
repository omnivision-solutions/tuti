"use client";

import { BookOpenIcon } from "lucide-react";
import { useSyncExternalStore } from "react";

import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { DOCS_READING_ATTRIBUTE, DOCS_READING_KEY } from "@/lib/docs-reading";

/** Reading mode's switch, on an article: on, the docs tree and "On this page" go and the article is alone; pressed again, they're back. */
export function ReadingModeToggle() {
  // The attribute on <html> (the layout's script sets it before the page shows) is the one place it's kept.
  const on = useSyncExternalStore(subscribe, () => document.documentElement.hasAttribute(DOCS_READING_ATTRIBUTE), () => false);
  const toggle = () => {
    const next = !on;
    document.documentElement.toggleAttribute(DOCS_READING_ATTRIBUTE, next);
    try {
      if (next) localStorage.setItem(DOCS_READING_KEY, "1");
      else localStorage.removeItem(DOCS_READING_KEY);
    } catch {
      // Storage blocked: on for this page only.
    }
  };
  return (
    // An icon beside Copy page: quiet until it's wanted. Named for screen readers, and in a tooltip on hover and on focus.
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Reading mode"
            aria-pressed={on}
            onClick={toggle}
            className="text-muted-foreground aria-pressed:bg-soft aria-pressed:text-soft-foreground"
          />
        }
      >
        <BookOpenIcon aria-hidden />
      </TooltipTrigger>
      <TooltipContent>{on ? "Reading mode: show the docs menu again" : "Reading mode: hide the docs menu and read the article alone"}</TooltipContent>
    </Tooltip>
  );
}

function subscribe(changed: () => void) {
  const observer = new MutationObserver(changed);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: [DOCS_READING_ATTRIBUTE] });
  return () => observer.disconnect();
}
