"use client";

import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";

/**
 * "Sign in" on a portal that comes back to this page afterwards, with its query
 * (e.g. a post title prefilled from "Post this as feedback").
 */
export function SignInLink({ className, children }: { className?: string; children: React.ReactNode }) {
  // On the server the path can still be the rewritten /portal/<project>/… one (see proxy.ts).
  const path = usePathname().replace(/^\/portal\/[^/]+/, "") || "/";
  const search = useSearchParams().toString();
  const here = search ? `${path}?${search}` : path;
  const href = /^\/sign-(in|up)\b/.test(path)
    ? `/sign-in${search ? `?${search}` : ""}`
    : here === "/"
      ? "/sign-in"
      : `/sign-in?${new URLSearchParams({ next: here })}`;
  return (
    <Link href={href} className={className}>
      {children}
    </Link>
  );
}
