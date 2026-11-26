"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";

import { usePortalHref, usePortalLanguagePrefix, usePortalPath } from "@/components/portal-base";
import { withLanguage } from "@/lib/language-addresses";

/**
 * The portal's sign-in page, coming back to this page afterwards with its query
 * (e.g. a post title prefilled from "Post this as feedback").
 */
export function useSignInHref() {
  const path = usePortalPath();
  const at = usePortalHref();
  const prefix = usePortalLanguagePrefix();
  const search = useSearchParams().toString();
  // In the page's language: every way of signing in comes back to it, a language's home too (without `next` it's /).
  const here = withLanguage(prefix, search ? `${path}?${search}` : path);
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
