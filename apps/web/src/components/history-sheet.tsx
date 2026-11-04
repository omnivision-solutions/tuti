"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import type { ReactNode } from "react";

import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";

/**
 * An article's History (or its Verify panel, `title`), in a panel from the right over its page: open while the address
 * has `?history` (a version picked in it adds `&revision=…`; `?verify` for Verify), so it's a link like any other;
 * closing it goes back to the article's own address, which never left.
 */
export function HistorySheet({ open, title = "History", description, children }: { open: boolean; title?: string; description: string; children: ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  // Closed: the article's own address, with what else it had (`from`), not the panel's.
  const close = () => {
    const kept = new URLSearchParams(searchParams);
    ["history", "verify", "revision"].forEach((key) => kept.delete(key));
    router.replace(kept.size > 0 ? `${pathname}?${kept}` : pathname, { scroll: false });
  };
  return (
    <Sheet open={open} onOpenChange={(next) => !next && close()}>
      <SheetContent className="gap-0 data-[side=right]:w-full data-[side=right]:sm:max-w-2xl">
        <SheetHeader className="border-b pr-12">
          <SheetTitle>{title}</SheetTitle>
          <SheetDescription>{description}</SheetDescription>
        </SheetHeader>
        {/* Its cards keep their height (a card clips what overflows it), so a long version's changes scroll in the panel. */}
        <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-4 *:shrink-0">{children}</div>
      </SheetContent>
    </Sheet>
  );
}
