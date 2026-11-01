"use client";

import { UserIcon } from "lucide-react";
import type { ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet";

/** The person beside the conversation: a column where its pane is wide enough (an `@container`, 48rem), a sheet where not. */
export function PersonDetails({ name, children }: { name: string; children: ReactNode }) {
  return (
    <>
      {/* In the column beside the conversation, which holds it in view. */}
      <aside aria-label="About them" className="hidden @3xl:block">
        <Card size="sm">
          <CardContent>{children}</CardContent>
        </Card>
      </aside>
      <Sheet>
        <SheetTrigger render={<Button variant="outline" size="sm" className="h-auto max-w-full self-start text-left break-all whitespace-normal @3xl:hidden" />}>
          <UserIcon />
          About {name}
        </SheetTrigger>
        <SheetContent className="overflow-y-auto">
          <SheetHeader>
            <SheetTitle>About {name}</SheetTitle>
          </SheetHeader>
          <div className="px-4 pb-4">{children}</div>
        </SheetContent>
      </Sheet>
    </>
  );
}
