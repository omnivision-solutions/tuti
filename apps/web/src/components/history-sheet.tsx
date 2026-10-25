"use client";

import { usePathname, useRouter } from "next/navigation";
import type { ReactNode } from "react";

import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";

/**
 * An article's History, in a panel from the right over its page: open while the address has `?history`
 * (a version picked in it adds `&revision=…`), so it's a link like any other; closing it goes back to
 * the article's own address, which never left.
 */
export function HistorySheet({ open, description, children }: { open: boolean; description: string; children: ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  return (
    <Sheet open={open} onOpenChange={(next) => !next && router.replace(pathname, { scroll: false })}>
      <SheetContent className="gap-0 data-[side=right]:w-full data-[side=right]:sm:max-w-2xl">
        <SheetHeader className="border-b pr-12">
          <SheetTitle>History</SheetTitle>
          <SheetDescription>{description}</SheetDescription>
        </SheetHeader>
        <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-4">{children}</div>
      </SheetContent>
    </Sheet>
  );
}
