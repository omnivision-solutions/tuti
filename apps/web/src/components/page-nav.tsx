import Link from "next/link";
import type { ReactNode } from "react";

import { buttonVariants } from "@/components/ui/button";

type PageLink = { href: string; label: string } | null;

/**
 * A list's pages: the way back, which of them these are (`children`, e.g. "51–100 of 1,250") and the way on, together
 * in the middle. Not at the edges: the bottom right is Tuti's chat launcher's, and on phones the page already ends clear
 * of it (AppShell).
 */
export function PageNav({ label = "Pages", back, on, children }: { label?: string; back: PageLink; on: PageLink; children?: ReactNode }) {
  return (
    <nav aria-label={label} className="flex flex-wrap items-center justify-center gap-x-4 gap-y-2">
      {back && (
        <Link href={back.href} className={buttonVariants({ variant: "outline", size: "sm" })}>
          {back.label}
        </Link>
      )}
      {children && <span className="text-sm text-muted-foreground tabular-nums">{children}</span>}
      {on && (
        <Link href={on.href} className={buttonVariants({ variant: "outline", size: "sm" })}>
          {on.label}
        </Link>
      )}
    </nav>
  );
}
