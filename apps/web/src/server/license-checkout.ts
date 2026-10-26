"use server";

import { prisma } from "@tuti/db";
import { log } from "@tuti/shared";
import { redirect } from "next/navigation";

import { LICENSE_ID, licensePage, licensePrice } from "./license-sales";
import { createSubscriptionCheckout } from "./stripe";

/**
 * "Buy a licence" on tuti.so/license (docs/plan.md, Licences): a Stripe Checkout page for the monthly
 * licence of one project on one installation. Anyone with the page may pay for it; what they buy is
 * named by the ids in the link "Get a licence" opened. The subscription carries both ids, and Stripe's
 * webhook turns the licence on once it's paid (server/subscriptions.ts).
 */
export async function buyLicense(form: FormData): Promise<void> {
  const installation = String(form.get("installation") ?? "");
  const project = String(form.get("project") ?? "");
  const price = licensePrice();
  if (!price || !LICENSE_ID.test(installation) || !LICENSE_ID.test(project)) {
    redirect(licensePage({ installation, project }).toString());
  }
  const license = await prisma.license.findUnique({ where: { installationId_projectId: { installationId: installation, projectId: project } } });
  if (license?.active) {
    redirect(licensePage({ installation, project }).toString());
  }
  let url: string;
  try {
    ({ url } = await createSubscriptionCheckout({
      price,
      metadata: { licenseInstallation: installation, licenseProject: project },
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
