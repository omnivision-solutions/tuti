"use client";

import { UserIcon } from "lucide-react";
import type { ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet";

/** The person beside the conversation: a column from laptop width up, a sheet below it. */
export function PersonDetails({ name, children }: { name: string; children: ReactNode }) {
  return (
    <>
      <aside aria-label="About them" className="hidden lg:block">
        <Card size="sm" className="sticky top-16">
          <CardContent>{children}</CardContent>
        </Card>
      </aside>
      <Sheet>
        <SheetTrigger render={<Button variant="outline" size="sm" className="h-auto max-w-full self-start text-left break-all whitespace-normal lg:hidden" />}>
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
