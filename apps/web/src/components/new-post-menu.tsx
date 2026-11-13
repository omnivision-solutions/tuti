import { ChevronDownIcon, PlusIcon } from "lucide-react";
import Link from "next/link";

import { Button, buttonVariants } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";

/** What a board's post button says (Settings → Boards → Button); a board without its own words says "New post". */
export const postButtonText = (board: { postButton: string | null }) => board.postButton ?? "New post";

/**
 * A portal page's one filled primary for posting (docs/design.md → Portals). One board: a link to its form, in that
 * board's own words. More: "New post", a menu of each board's own words with its name under them. `round`: the phone's
 * round + in the title row, named the same.
 */
export function NewPostMenu({ boards, round = false }: { boards: { name: string; postButton: string | null; href: string }[]; round?: boolean }) {
  const only = boards.length === 1 ? boards[0]! : undefined;
  if (boards.length === 0) {
    return null;
  }
  const label = only ? postButtonText(only) : "New post";
  const look = round ? ({ size: "icon-lg", className: "rounded-full" } as const) : ({ className: "font-semibold" } as const);
  if (only) {
    return (
      <Link href={only.href} aria-label={round ? label : undefined} className={buttonVariants(look)}>
        <PlusIcon aria-hidden data-icon={round ? undefined : "inline-start"} />
        {!round && label}
      </Link>
    );
  }
  return (
    <DropdownMenu>
      <DropdownMenuTrigger render={<Button {...look} aria-label={round ? label : undefined} />}>
        <PlusIcon aria-hidden data-icon={round ? undefined : "inline-start"} />
        {!round && (
          <>
            {label}
            <ChevronDownIcon aria-hidden data-icon="inline-end" />
          </>
        )}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-auto min-w-48">
        {boards.map((board) => (
          <DropdownMenuItem key={board.href} render={<Link href={board.href} />} className="flex-col items-start gap-0 px-2.5 py-1.5">
            <span className="font-medium">{postButtonText(board)}</span>{" "}
            <span className="text-xs text-muted-foreground">{board.name}</span>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
