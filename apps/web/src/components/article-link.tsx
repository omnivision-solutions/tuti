"use client";

import { PreviewCard } from "@base-ui/react/preview-card";
import Link from "next/link";
import type { ReactNode } from "react";

export type ArticlePreview = { title: string; description: string; collection: string | null };

/**
 * A link in an article to another of the portal's articles: in the same tab, at this address. Pointed at or focused, a card
 * previews it (its collection, title and description) when this reader may open it. A tap on a touch screen just follows it:
 * the card opens on hover and focus only, so a link still does what links do there.
 */
export function ArticleLink({ href, preview, children }: { href: string; preview: ArticlePreview | null; children: ReactNode }) {
  if (!preview) {
    return <Link href={href}>{children}</Link>;
  }
  return (
    <PreviewCard.Root>
      {/* data-preview: this link has a card (journeys check a locked article's link has none). */}
      <PreviewCard.Trigger render={<Link href={href} data-preview="" />}>{children}</PreviewCard.Trigger>
      <PreviewCard.Portal>
        {/* The popover's look (components/ui/popover.tsx). */}
        <PreviewCard.Positioner className="isolate z-50 outline-none" sideOffset={6} collisionPadding={16}>
          <PreviewCard.Popup
            data-slot="article-preview"
            className="flex w-80 max-w-(--available-width) origin-(--transform-origin) flex-col gap-1 rounded-lg bg-popover p-4 text-popover-foreground shadow-md ring-1 ring-foreground/10 duration-100 outline-none data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95 dark:shadow-lg dark:shadow-black/60 dark:ring-foreground/25"
          >
            {preview.collection && <p className="text-xs font-medium text-primary">{preview.collection}</p>}
            <p className="font-heading font-semibold break-words">{preview.title}</p>
            {preview.description && <p className="line-clamp-3 text-sm break-words text-muted-foreground">{preview.description}</p>}
          </PreviewCard.Popup>
        </PreviewCard.Positioner>
      </PreviewCard.Portal>
    </PreviewCard.Root>
  );
}
