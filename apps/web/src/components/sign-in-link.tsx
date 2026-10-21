"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";

import { usePortalHref, usePortalPath } from "@/components/portal-base";

/**
 * "Sign in" on a portal that comes back to this page afterwards, with its query
 * (e.g. a post title prefilled from "Post this as feedback").
 */
export function SignInLink({ className, children }: { className?: string; children: React.ReactNode }) {
  const path = usePortalPath();
  const at = usePortalHref();
  const search = useSearchParams().toString();
  const here = search ? `${path}?${search}` : path;
  const href = /^\/sign-(in|up)\b/.test(path)
    ? `/sign-in${search ? `?${search}` : ""}`
    : // Nothing to come back to from a password reset (and its link's token stays out of the URL).
      here === "/" || /^\/(forgot|reset)-password\b/.test(path)
      ? "/sign-in"
      : `/sign-in?${new URLSearchParams({ next: here })}`;
  return (
    <Link href={at(href)} className={className}>
      {children}
    </Link>
  );
}
