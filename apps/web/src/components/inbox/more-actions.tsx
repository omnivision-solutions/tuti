"use client";

import { EllipsisIcon, SearchIcon } from "lucide-react";
import { type ReactNode, useState } from "react";
import { usePathname } from "next/navigation";
import { OPEN_COMMAND_MENU } from "@/lib/command-menu-event";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";

/** Keep dialog actions mounted after their menu closes so they can finish and return focus. */
export function ConversationMore({ children, label = "More actions" }: { children: ReactNode; label?: string }) {
  const [open, setOpen] = useState(false);
  const pathname = usePathname();
  const [place, setPlace] = useState(pathname);
  if (place !== pathname) {
    setPlace(pathname);
    setOpen(false);
  }
  return (
    <DropdownMenu open={open} onOpenChange={setOpen} modal={false}>
      <DropdownMenuTrigger render={<Button variant="outline" size="icon-sm" aria-label={label} />}>
        <EllipsisIcon />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" keepMounted className="w-56">
        {children}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** Opens the existing project search without leaving the Inbox. */
export function InboxSearchButton() {
  return (
    <Button variant="outline" size="icon-sm" aria-label="Search project" onClick={() => window.dispatchEvent(new Event(OPEN_COMMAND_MENU))}>
      <SearchIcon />
    </Button>
  );
}
