"use client";

import { EllipsisIcon, ExternalLinkIcon, MergeIcon } from "lucide-react";
import { type ComponentProps, useRef, useState } from "react";

import { MergePostDialog } from "@/components/merge-post-dialog";
import { Button, buttonVariants } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";

/**
 * A post's page's actions in its pane header: "View on portal" and "Merge into…" (a merged post has none) in words
 * from 48rem of the shell; under it, where the row is short, both in words under a round "More actions".
 */
export function PostActions({ portal, merge }: { portal: string; merge?: Omit<ComponentProps<typeof MergePostDialog>, "open" | "onOpenChange" | "triggerClassName" | "finalFocus"> }) {
  const [merging, setMerging] = useState(false);
  // Merge closed: focus back to More actions where that's what shows (its own button is hidden there), else its own.
  const more = useRef<HTMLButtonElement>(null);
  const backToMore = () => (more.current?.checkVisibility() ? more.current : true);
  const wide = "@max-[48rem]/app:hidden";
  return (
    <>
      <a href={portal} target="_blank" rel="noreferrer" className={buttonVariants({ variant: "outline", size: "sm", className: wide })}>
        <ExternalLinkIcon />
        View on portal
      </a>
      {merge && <MergePostDialog {...merge} open={merging} onOpenChange={setMerging} triggerClassName={wide} finalFocus={backToMore} />}
      <DropdownMenu>
        <DropdownMenuTrigger render={<Button ref={more} variant="outline" size="icon-sm" aria-label="More actions" className="@min-[48rem]/app:hidden" />}>
          <EllipsisIcon />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-auto min-w-44">
          <DropdownMenuItem render={<a href={portal} target="_blank" rel="noreferrer" />}>
            <ExternalLinkIcon />
            View on portal
          </DropdownMenuItem>
          {merge && (
            <DropdownMenuItem onClick={() => setMerging(true)}>
              <MergeIcon />
              Merge into…
            </DropdownMenuItem>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
    </>
  );
}
