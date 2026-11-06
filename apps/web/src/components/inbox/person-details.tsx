"use client";

import { UserIcon } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet";

/** Opens the person's sheet (PersonDetails) from elsewhere on the page: the top bar's menu on phones (AboutButton). */
const OPEN_PERSON_DETAILS = "tuti:person-details";

/** The person beside the conversation: a column where its pane is wide enough (an `@container`, 48rem), a sheet where not. */
export function PersonDetails({ name, children }: { name: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const show = () => setOpen(true);
    window.addEventListener(OPEN_PERSON_DETAILS, show);
    return () => window.removeEventListener(OPEN_PERSON_DETAILS, show);
  }, []);

  return (
    <>
      {/* In the column beside the conversation, which holds it in view. */}
      <aside aria-label="About them" className="hidden @3xl:block">
        <Card size="sm">
          <CardContent>{children}</CardContent>
        </Card>
      </aside>
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetTrigger render={<Button variant="outline" size="sm" className="h-auto max-w-full self-start text-left break-all whitespace-normal @3xl:hidden" />}>
          <UserIcon />
          About {name}
        </SheetTrigger>
        <SheetContent className="overflow-y-auto">
          <SheetHeader>
            {/* Clear of the sheet's close button, a long address broken anywhere to fit. */}
            <SheetTitle className="pr-6 break-all">About {name}</SheetTitle>
          </SheetHeader>
          <div className="px-4 pb-4">{children}</div>
        </SheetContent>
      </Sheet>
    </>
  );
}

/**
 * The person's sheet from the top bar's menu, on phones only: a conversation opens at its newest message, so the
 * button above its messages is often far up the page.
 */
export function AboutButton({ name }: { name: string }) {
  return (
    <Button variant="ghost" size="sm" className="hidden max-w-full phonebar:inline-flex" onClick={() => window.dispatchEvent(new Event(OPEN_PERSON_DETAILS))}>
      <UserIcon />
      {/* A long name (an address) cut short in the menu's width; the sheet says it in full. */}
      <span className="truncate">About {name}</span>
    </Button>
  );
}
