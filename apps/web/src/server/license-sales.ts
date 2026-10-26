import { badgePrice } from "@tuti/shared";

import { appUrl } from "@/lib/hosts";
import { licensePrivateKey } from "./license-server";

/** An installation's or a project's id, as the licence page takes them. */
export const LICENSE_ID = /^[A-Za-z0-9_-]{1,100}$/;

/**
 * The licence's Stripe price where tuti.so sells licences by Checkout: the licence server
 * (LICENSE_PRIVATE_KEY), Stripe set up, and the add-on's monthly price (STRIPE_PRICE_BADGE_MONTHLY,
 * the same $49 a month). Null elsewhere: the page says to email instead.
 */
export function licensePrice(): string | null {
  return licensePrivateKey() && process.env.STRIPE_SECRET_KEY && process.env.STRIPE_WEBHOOK_SECRET ? badgePrice("month") : null;
}

/** tuti.so/license for a project on an installation, where Stripe sends the buyer back. */
export function licensePage(ids: { installation: string; project: string }, extra: Record<string, string> = {}): URL {
  const url = new URL("/license", appUrl());
  url.search = new URLSearchParams({ ...ids, ...extra }).toString();
  return url;
}
