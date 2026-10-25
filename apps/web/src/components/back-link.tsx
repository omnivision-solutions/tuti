import { ArrowLeftIcon } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

/** "← Feedback": the way back to the list a page belongs to, above its header (in the app, PageHeader's `back`). */
export function BackLink({ href, children, className }: { href: string; children: ReactNode; className?: string }) {
  return (
    <Link
      href={href}
      className={cn("inline-flex items-center gap-1.5 self-start text-sm text-muted-foreground transition-colors hover:text-foreground [&>svg]:size-4", className)}
    >
      <ArrowLeftIcon />
      <span className="min-w-0">{children}</span>
    </Link>
  );
}
