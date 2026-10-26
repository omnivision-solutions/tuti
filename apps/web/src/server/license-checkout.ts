"use server";

import { prisma } from "@tuti/db";
import { log } from "@tuti/shared";
import { redirect } from "next/navigation";

import { LICENSE_ID, licensePage, licensePrice } from "./license-sales";
import { createSubscriptionCheckout } from "./stripe";

/**
 * Licence checkouts started a minute, across everyone: the page is public, so a flood of them can't use up
 * Stripe's rate limit, which plans and top-ups share. Over it, the buyer is asked to try again in a moment.
 * ponytail: counted per server process (tuti.so runs one web instance); a shared count once it runs several.
 */
const CHECKOUTS_PER_MINUTE = 20;
/** When the checkouts of the last minute started: a rolling minute, so no burst of twice the limit spans a reset. */
let checkouts: number[] = [];

function checkoutAllowed(now = Date.now()): boolean {
  checkouts = checkouts.filter((time) => now - time < 60_000);
  if (checkouts.length >= CHECKOUTS_PER_MINUTE) {
    return false;
  }
  checkouts.push(now);
  return true;
}

/**
 * "Buy a licence" on tuti.so/license (docs/plan.md, Licences): a Stripe Checkout page for the licence
 * of one project on one installation, billed each month or each year (`interval`). Anyone with the page may pay for it; what they buy is
 * named by the ids in the link "Get a licence" opened. The subscription carries both ids, and Stripe's
 * webhook turns the licence on once it's paid (server/subscriptions.ts).
 */
export async function buyLicense(form: FormData): Promise<void> {
  const installation = String(form.get("installation") ?? "");
  const project = String(form.get("project") ?? "");
  const price = licensePrice(form.get("interval") === "year" ? "year" : "month");
  if (!price || !LICENSE_ID.test(installation) || !LICENSE_ID.test(project)) {
    redirect(licensePage({ installation, project }).toString());
  }
  const license = await prisma.license.findUnique({ where: { installationId_projectId: { installationId: installation, projectId: project } } });
  if (license?.active) {
    redirect(licensePage({ installation, project }).toString());
  }
  if (!checkoutAllowed()) {
    log.warn("Licence checkouts over their limit a minute", { installation, project });
    redirect(licensePage({ installation, project }, { failed: "1" }).toString());
  }
  let url: string;
  try {
    ({ url } = await createSubscriptionCheckout({
      price,
      metadata: { licenseInstallation: installation, licenseProject: project },
      description: `Tuti licence for project ${project} on installation ${installation}`,
      reference: installation,
      customer: null,
      email: null,
      successUrl: licensePage({ installation, project }, { paid: "1" }).toString(),
      cancelUrl: licensePage({ installation, project }).toString(),
    }));
  } catch (error) {
    log.error("Couldn't start a licence's Stripe Checkout", { installation, project, error: String(error) });
    redirect(licensePage({ installation, project }, { failed: "1" }).toString());
  }
  redirect(url);
}
