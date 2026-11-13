import { readFileSync } from "node:fs";

import { z } from "zod";

/**
 * Billing (docs/plan.md, Plans): what a server sells, from one JSON file at BILLING_CONFIG (a path; on Tuti's cloud a
 * file mounted into the app's and the worker's containers). Without one, billing is off: nothing is sold and every
 * project has every feature with no limits (self-hosted). The file is read once per process: restart to apply an edit.
 * `billing.schema.json` (pnpm --filter @tuti/shared billing:schema) is its JSON Schema, for editors; an invalid file
 * stops the server starting rather than selling the wrong thing.
 */

/** What a plan may include (planIncludes). Each needs code behind it, so the list lives here; the file says which plan has which. */
export const PLAN_FEATURES = ["customDomain", "sitePath", "privatePortal", "codeChanges", "emailDomain", "launcherIcon", "reporting", "aiTuning"] as const;

const count = z.number().int().min(0);
const days = z.number().int().min(1);

/** Stripe price ids: the one sold first, then any older ones, so customers who subscribed at an older price keep their plan. */
const stripePrices = z.array(z.string().min(1)).min(1);

/** A price billed each month or each year: what it shows a month (a year's price shows its monthly share) and its Stripe prices. */
const price = z.object({ perMonth: z.number().min(0), stripe: stripePrices }).strict();

const plan = z
  .object({
    key: z.string().regex(/^[a-z][a-z0-9-]*$/, "lowercase letters, digits and dashes").describe("The plan's id, which projects and the API know it by."),
    name: z.string().min(1).describe("What it's called in the app and on the pricing page."),
    prices: z
      .object({ month: price, year: price })
      .partial()
      .strict()
      .default({})
      .describe("How it's billed, each month and each year (perMonth: what a month shows; stripe: price ids, the one sold first). Without prices (usually the default plan) it isn't sold."),
    features: z.array(z.enum(PLAN_FEATURES)).describe("What it includes."),
    limits: z
      .object({
        seats: count.nullable().describe("Team members; null: no limit."),
        boards: count.nullable().describe("Feedback boards; null: no limit."),
        articles: count.nullable().describe("Published help center articles; null: no limit."),
        historyDays: days.describe("How many days back closed inbox conversations and AI conversations show."),
        articleVersions: days.describe("Saved versions of a help center article its team sees, the latest included."),
        reportingDays: days.nullable().describe("The longest range Reporting shows, in days; null: every range."),
      })
      .strict(),
    extras: z.array(z.string().min(1)).default([]).describe('More lines its pricing card lists after what the file says it has, e.g. "Priority support".'),
    featured: z.boolean().default(false).describe("Its card stands out on the pricing page, and its Upgrade is Billing's main button."),
    monthlyCredits: count.default(0).describe("AI credits each paid month gives (a year: twelve months' worth), with AI credits on."),
  })
  .strict();

export const billingSchema = z
  .object({
    $schema: z.string().optional(),
    plans: z.array(plan).min(1).describe("The plans, cheapest first: an upgrade names the first one after the project's that has what it needs."),
    defaultPlan: z.string().describe("The plan of a project without a live paid plan (none yet, or it ended), and of one whose plan this file doesn't list."),
    badge: z
      .object({ month: price, year: price })
      .partial()
      .strict()
      .optional()
      .describe('The add-on hiding "Powered by tuti", priced for plans billed each month and each year (and self-hosted licences, on Tuti\'s licence server). Absent: not sold.'),
    historyKeptDays: days.default(365).describe("Days closed conversations and AI conversations are kept before they're deleted, never fewer than the longest plan's history."),
  })
  .strict()
  .superRefine((config, context) => {
    const keys = config.plans.map(({ key }) => key);
    keys.forEach((key, index) => {
      if (keys.indexOf(key) !== index) {
        context.addIssue({ code: "custom", path: ["plans", index, "key"], message: `"${key}" is listed twice` });
      }
      // ponytail: plans are still the database's FREE, PRO and BUSINESS; any key once projects store a plan's key.
      if (!["free", "pro", "business"].includes(key)) {
        context.addIssue({ code: "custom", path: ["plans", index, "key"], message: "must be free, pro or business for now" });
      }
    });
    if (!keys.includes(config.defaultPlan)) {
      context.addIssue({ code: "custom", path: ["defaultPlan"], message: `"${config.defaultPlan}" isn't one of the plans` });
    } else if (config.defaultPlan !== "free") {
      // ponytail: a project without a paid plan is stored as FREE; any default once projects store a plan's key.
      context.addIssue({ code: "custom", path: ["defaultPlan"], message: "must be free for now" });
    }
    const stripe = [...config.plans.flatMap(({ prices }) => Object.values(prices)), ...Object.values(config.badge ?? {})].flatMap((price) => price.stripe);
    stripe.forEach((id, index) => {
      if (stripe.indexOf(id) !== index) {
        context.addIssue({ code: "custom", path: [], message: `Stripe price ${id} is listed twice` });
      }
    });
  });

export type BillingConfig = z.output<typeof billingSchema>;
export type BillingPlan = BillingConfig["plans"][number];

const loaded = new Map<string, BillingConfig>();

/**
 * This server's billing file (BILLING_CONFIG), or null without one: billing off. A file that can't be read or isn't
 * valid throws, naming what's wrong.
 */
export function billingConfig(): BillingConfig | null {
  const path = process.env.BILLING_CONFIG?.trim();
  if (!path) {
    return null;
  }
  if (!loaded.has(path)) {
    let text: string;
    try {
      text = readFileSync(path, "utf8");
    } catch (error) {
      // Never billing off: on a server selling plans, a mount gone missing would give every project everything.
      throw new Error(`BILLING_CONFIG (${path}) can't be read: ${(error as Error).message}`);
    }
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch (error) {
      throw new Error(`BILLING_CONFIG (${path}) isn't JSON: ${(error as Error).message}`);
    }
    const parsed = billingSchema.safeParse(json);
    if (!parsed.success) {
      throw new Error(`BILLING_CONFIG (${path}) isn't valid:\n${z.prettifyError(parsed.error)}`);
    }
    loaded.set(path, parsed.data);
  }
  return loaded.get(path)!;
}
