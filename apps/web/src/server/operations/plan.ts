import { prisma } from "@tuti/db";
import { log, planPrice, planSalesEnabled, plansEnabled } from "@tuti/shared";
import { z } from "zod";

import { appUrl } from "@/lib/hosts";

import { createPortal, createSubscriptionCheckout } from "../stripe";
import { defineOperation, OperationError } from "./define";
import { projectSlug } from "./read";

/** The project's Billing page, where Stripe sends the team back. */
const billingUrl = async (projectId: string) => new URL(`/app/${await projectSlug(projectId)}/settings/billing`, appUrl());

export const getPlan = defineOperation({
  name: "plan.get",
  summary:
    "The project's plan, on a server that sells plans (`enabled`): `free`, `pro` or `business`, and for a paid plan how it's billed (`interval`: month or year), Stripe's `status` (`past_due` while a failed payment is retried), when its period ends (`periodEnd`: it renews then) and, if it's cancelled, when it ends (`endsAt`)",
  method: "GET",
  path: "/plan",
  scope: "read",
  access: "admin",
  input: z.object({}),
  run: async ({ projectId }) => {
    const project = await prisma.project.findUniqueOrThrow({
      where: { id: projectId },
      select: { plan: true, planInterval: true, planStatus: true, planPeriodEnd: true, planEndsAt: true },
    });
    return {
      enabled: plansEnabled(),
      plan: project.plan.toLowerCase() as "free" | "pro" | "business",
      interval: project.planInterval as "month" | "year" | null,
      status: project.planStatus,
      periodEnd: project.planPeriodEnd,
      endsAt: project.planEndsAt,
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
