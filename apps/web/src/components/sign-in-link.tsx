"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";

import { usePortalHref, usePortalPath } from "@/components/portal-base";

/**
 * The portal's sign-in page, coming back to this page afterwards with its query
 * (e.g. a post title prefilled from "Post this as feedback").
 */
export function useSignInHref() {
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
  return at(href);
}

/** "Sign in" on a portal, coming back to this page afterwards (`useSignInHref`). */
export function SignInLink({ className, children }: { className?: string; children: React.ReactNode }) {
  return (
    <Link href={useSignInHref()} className={className}>
      {children}
    </Link>
  );
}
