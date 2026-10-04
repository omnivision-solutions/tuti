import { ArrowLeftIcon } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";

/** "← Feedback": the way back to the list a page belongs to, above its header. */
export function BackLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <Link
      href={href}
      className="inline-flex items-center gap-1.5 self-start text-sm text-muted-foreground transition-colors hover:text-foreground [&>svg]:size-4"
    >
      <ArrowLeftIcon />
      {children}
    </Link>
  );
}
