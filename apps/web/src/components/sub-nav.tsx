"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";

import { activeHref } from "@/lib/active-link";
import { cn } from "@/lib/utils";

/** A page's sections as links under its header (Settings → Access, Single sign-on, …); they wrap on phones. */
export function SubNav({
  label,
  items,
  current: given,
}: {
  label: string;
  items: { title: ReactNode; href: string }[];
  /** The active item's href, when the URL's path alone doesn't say (views in the query string). */
  current?: string;
}) {
  const pathname = usePathname();
  const current = given ?? activeHref(pathname, items.map((item) => item.href));
  return (
    <nav aria-label={label} className="-mt-2 flex flex-wrap gap-x-1 gap-y-1 border-b">
      {items.map((item) => {
        const active = item.href === current;
        return (
          <Link
            key={item.href}
            href={item.href}
            aria-current={active ? "page" : undefined}
            className={cn(
              "-mb-px border-b-2 px-2.5 py-2 text-sm transition-colors",
              active ? "border-primary font-medium text-foreground" : "border-transparent text-muted-foreground hover:text-foreground",
            )}
          >
            {item.title}
          </Link>
        );
      })}
    </nav>
  );
}
