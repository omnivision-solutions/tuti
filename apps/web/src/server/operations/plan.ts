import { prisma } from "@tuti/db";
import { badgePrice, isBadgePrice, log, planIncludes, planNeeded, type PlanFeature, planPrice, planSalesEnabled, plansEnabled } from "@tuti/shared";
import { z } from "zod";

import { appUrl } from "@/lib/hosts";

import { addSubscriptionItem, createPortal, createSubscriptionCheckout, getSubscription, removeSubscriptionItem, StripeError } from "../stripe";
import { syncSubscription } from "../subscriptions";
import { defineOperation, OperationError } from "./define";
import { projectSlug } from "./read";

/** The project's Billing page, where Stripe sends the team back. */
/** Refuses (402) what the project's plan doesn't include (see planIncludes), saying which plan does. */
export async function requirePlan(projectId: string, feature: PlanFeature): Promise<void> {
  const { plan } = await prisma.project.findUniqueOrThrow({ where: { id: projectId }, select: { plan: true } });
  if (!planIncludes(plan, feature)) {
    throw new OperationError(402, "plan_required", `${planNeeded(feature)} See Settings → Billing.`);
  }
}

const billingUrl = async (projectId: string) => new URL(`/app/${await projectSlug(projectId)}/settings/billing`, appUrl());

export const getPlan = defineOperation({
  name: "plan.get",
  summary:
    "The project's plan, on a server that sells plans (`enabled`): `free`, `pro` or `business`, and for a paid plan how it's billed (`interval`: month or year), Stripe's `status` (`past_due` while a failed payment is retried), when its period ends (`periodEnd`: it renews then), if it's cancelled, when it ends (`endsAt`), and whether it has the add-on hiding \"Powered by tuti\" (`badge`; see plan.badge)",
  method: "GET",
  path: "/plan",
  scope: "read",
  access: "admin",
  input: z.object({}),
  run: async ({ projectId }) => {
    const project = await prisma.project.findUniqueOrThrow({
      where: { id: projectId },
      select: { plan: true, planInterval: true, planStatus: true, planPeriodEnd: true, planEndsAt: true, badgeAddOn: true },
    });
    return {
      enabled: plansEnabled(),
      plan: project.plan.toLowerCase() as "free" | "pro" | "business",
      interval: project.planInterval as "month" | "year" | null,
      status: project.planStatus,
      periodEnd: project.planPeriodEnd,
      endsAt: project.planEndsAt,
      badge: project.badgeAddOn,
    };
  },
});

export const subscribePlan = defineOperation({
  name: "plan.subscribe",
  summary:
    "Start a paid plan (`pro` or `business`, billed each `month` or `year`): a Stripe Checkout page (`url`) to pay on; the plan starts once Stripe says it's paid. Refused (409) while the project has a plan (change it with plan.manage), and off (503) where plans aren't sold",
  method: "POST",
  path: "/plan/subscribe",
  scope: "write",
  access: "admin",
  input: z.object({ plan: z.enum(["pro", "business"]), interval: z.enum(["month", "year"]).default("month") }),
  example: { plan: "pro", interval: "month" },
  run: async ({ actor, projectId }, input) => {
    const price = planSalesEnabled() ? planPrice(input.plan === "pro" ? "PRO" : "BUSINESS", input.interval) : null;
    if (!price) {
      throw new OperationError(503, "plans_unavailable", "That plan isn't sold on this server");
    }
    const [project, buyer, billing] = await Promise.all([
      prisma.project.findUniqueOrThrow({ where: { id: projectId }, select: { plan: true, stripeCustomerId: true } }),
      actor.kind === "user" ? prisma.user.findUnique({ where: { id: actor.userId }, select: { email: true } }) : null,
      billingUrl(projectId),
    ]);
    if (project.plan !== "FREE") {
      throw new OperationError(409, "has_plan", "This project has a plan already. Change it from Manage plan.");
    }
    try {
      const session = await createSubscriptionCheckout({
        price,
        projectId,
        customer: project.stripeCustomerId,
        email: buyer?.email ?? null,
        successUrl: `${billing}?subscribed=1`,
        cancelUrl: billing.toString(),
      });
      return { url: session.url };
    } catch (error) {
      log.error("Starting a Stripe Checkout for a plan failed", { projectId, error });
      throw new OperationError(502, "stripe_failed", "Couldn't open the payment page. Try again in a moment.");
    }
  },
});

export const managePlan = defineOperation({
  name: "plan.manage",
  summary:
    "Stripe's customer portal for the project (`url`): change or cancel its plan, update the card, and download invoices. Refused (409) for a project that has never had a plan",
  method: "POST",
  path: "/plan/manage",
  scope: "write",
  access: "admin",
  input: z.object({}),
  run: async ({ projectId }) => {
    const [project, billing] = await Promise.all([
      prisma.project.findUniqueOrThrow({ where: { id: projectId }, select: { stripeCustomerId: true } }),
      billingUrl(projectId),
    ]);
    // Only the key, not plans on: a server that stopped selling plans still lets its customers cancel.
    if (!project.stripeCustomerId || !process.env.STRIPE_SECRET_KEY) {
      throw new OperationError(409, "no_plan", "This project has never had a plan");
    }
    try {
      return { url: await createPortal({ customer: project.stripeCustomerId, returnUrl: billing.toString() }) };
    } catch (error) {
      log.error("Opening Stripe's customer portal failed", { projectId, error });
      throw new OperationError(502, "stripe_failed", "Couldn't open Stripe. Try again in a moment.");
    }
  },
});

export const setBadgeAddOn = defineOperation({
  name: "plan.badge",
  summary:
    'The add-on hiding "Powered by tuti" on the portal ($49 a month, on a paid plan): `on` adds it to the plan, charging what\'s left of the period at once, and hides the badge; `on: false` removes it (what\'s left of the period is credited to the next invoice) and shows the badge again. It ends with the plan. Refused (409) on the free plan or while a payment is failing, and 402 if the card is declined',
  method: "POST",
  path: "/plan/badge",
  scope: "write",
  access: "admin",
  input: z.object({ on: z.boolean() }),
  example: { on: true },
  run: async ({ projectId }, { on }) => {
    const project = await prisma.project.findUniqueOrThrow({
      where: { id: projectId },
      select: { plan: true, planInterval: true, planStatus: true, stripeSubscriptionId: true },
    });
    const price = planSalesEnabled() ? badgePrice(project.planInterval === "year" ? "year" : "month") : null;
    if (on && !price) {
      throw new OperationError(503, "plans_unavailable", 'Hiding "Powered by tuti" isn\'t sold on this server');
    }
    if (project.plan === "FREE" || !project.stripeSubscriptionId) {
      if (on) {
        throw new OperationError(409, "free_plan", 'Hiding "Powered by tuti" needs a paid plan');
      }
      return { on: false };
    }
    // Adding charges at once, so not while a payment is failing; removing only lowers the bill, so always.
    if (on && project.planStatus === "past_due") {
      throw new OperationError(409, "payment_failing", "The last payment didn't go through. Update the card in Manage plan first.");
    }
    const subscription = project.stripeSubscriptionId;
    try {
      // One change at a time per project, so two clicks can't add it twice.
      await prisma.$transaction(
        async (tx) => {
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(6, hashtext(${projectId}))`;
          const items = (await getSubscription(subscription)).items.data.filter((item) => isBadgePrice(item.price.id));
          if (on && items.length === 0) {
            await addSubscriptionItem(subscription, price!);
          }
          for (const item of on ? [] : items) {
            await removeSubscriptionItem(item.id);
          }
        },
        // Stripe's answers come within their 15-second timeouts.
        { timeout: 40_000 },
      );
    } catch (error) {
      if (error instanceof StripeError && error.status === 402) {
        throw new OperationError(402, "payment_failed", "The payment didn't go through. Update the card in Manage plan, then try again.");
      }
      log.error('Changing the "Powered by tuti" add-on on Stripe failed', { projectId, on, error });
      throw new OperationError(502, "stripe_failed", "Couldn't confirm the change with Stripe: it may have gone through. Check Billing in a moment before trying again.");
    }
    // Stripe's webhook says so too; read now so the badge changes at once.
    await syncSubscription(subscription);
    const { badgeAddOn } = await prisma.project.update({ where: { id: projectId }, data: { poweredBy: !on }, select: { badgeAddOn: true } });
    return { on: badgeAddOn };
  },
});
