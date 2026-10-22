"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

import { cn } from "@/lib/utils";

/** A page's sections as links under its header (Settings → Access, Single sign-on, …); they wrap on phones. */
export function SubNav({ label, items }: { label: string; items: { title: string; href: string }[] }) {
  const pathname = usePathname();
  return (
    <nav aria-label={label} className="-mt-2 flex flex-wrap gap-x-1 gap-y-1 border-b">
      {items.map((item) => {
        const active = pathname === item.href;
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
