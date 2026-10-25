import { prisma } from "@tuti/db";
import { creditBalance } from "@tuti/jobs";
import { creditsEnabled, creditsPerTopupDollar, planCredits, planSalesEnabled, plansEnabled, topupExpiryDays, topupsEnabled } from "@tuti/shared";
import Link from "next/link";
import { notFound } from "next/navigation";

import { BuyCredits } from "@/components/buy-credits";
import { BadgeAddOn, ManagePlan, PlanPicker } from "@/components/plan-picker";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { BADGE_PRICE, PLAN_PRICES, planPriceText } from "@/lib/plans";
import { credits } from "@/lib/usage-format";
import { getAdminProject } from "@/server/membership";
import { TOPUP_DOLLARS } from "@/server/operations/credits";

const SOURCES = { FREE: "Free credits", TOPUP: "Top-up", PLAN: "Plan", MANUAL: "Given by Tuti" } as const;

const day = (date: Date) => date.toLocaleDateString("en", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });

/**
 * Settings → Billing (with plans or AI credits on): the project's plan, and its AI credits (the balance,
 * and the credits it has left by when they expire).
 */
export default async function BillingSettingsPage(props: PageProps<"/app/[project]/settings/billing">) {
  const { project: slug } = await props.params;
  const project = await getAdminProject(slug);
  if (!project || !(creditsEnabled() || plansEnabled())) {
    notFound();
  }
  const [{ balance, grants }, plan] = await Promise.all([
    creditsEnabled() ? creditBalance(project.id) : { balance: 0, grants: [] },
    prisma.project.findUniqueOrThrow({ where: { id: project.id }, select: { plan: true, planInterval: true, planStatus: true, planPeriodEnd: true, planEndsAt: true, badgeAddOn: true } }),
  ]);
  // Back from Stripe's payment page: the credits or the plan come with Stripe's word that it's paid, usually within seconds.
  const searchParams = await props.searchParams;
  const paid = searchParams.paid === "1";
  const subscribed = searchParams.subscribed === "1";
  return (
    <>
      {(paid || subscribed) && (
        <Alert>
          <AlertDescription>
            Thanks for your payment. Your {paid ? "credits show" : "plan starts"} here as soon as Stripe confirms it, usually within a few seconds.
          </AlertDescription>
        </Alert>
      )}
      {plansEnabled() && (
        <Card>
          <CardHeader>
            <CardTitle>{plan.plan === "FREE" ? "Free" : PLAN_PRICES[plan.plan].name} plan</CardTitle>
            <CardDescription>
              {plan.plan === "FREE"
                ? "Upgrade this project for more. Plans are per project: readers are always unlimited."
                : [
                    planPriceText(plan.plan, plan.planInterval === "year" ? "year" : "month"),
                    plan.planEndsAt ? `Ends on ${day(plan.planEndsAt)}` : plan.planPeriodEnd && `Renews on ${day(plan.planPeriodEnd)}`,
                  ]
                    .filter(Boolean)
                    .join(" · ")}
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            {plan.planStatus === "past_due" && (
              <Alert variant="destructive">
                <AlertDescription>The last payment didn&apos;t go through. Stripe tries again; update the card in Manage plan.</AlertDescription>
              </Alert>
            )}
            {plan.plan !== "FREE" ? (
              <ManagePlan projectSlug={slug} />
            ) : planSalesEnabled() ? (
              <PlanPicker projectSlug={slug} credits={creditsEnabled() ? { PRO: planCredits("PRO"), BUSINESS: planCredits("BUSINESS") } : null} />
            ) : (
              <p className="text-sm text-muted-foreground">Plans can&apos;t be bought here right now.</p>
            )}
          </CardContent>
        </Card>
      )}
      {plansEnabled() && (
        <Card>
          <CardHeader>
            <CardTitle>Hide &quot;Powered by tuti&quot;</CardTitle>
            <CardDescription>
              {plan.badgeAddOn
                ? `Hidden: $${BADGE_PRICE} a month on this project's plan. It ends with the plan.`
                : plan.plan === "FREE"
                  ? `Paid plans can hide the badge at the foot of the portal for $${BADGE_PRICE} a month.`
                  : `The badge at the foot of the portal: hide it for $${BADGE_PRICE} a month, added to this project's plan.`}
            </CardDescription>
          </CardHeader>
          {plan.plan !== "FREE" && (plan.badgeAddOn || planSalesEnabled()) && (
            <CardContent>
              <BadgeAddOn projectSlug={slug} on={plan.badgeAddOn} />
            </CardContent>
          )}
        </Card>
      )}
      {creditsEnabled() && (
    <Card>
      <CardHeader>
        <CardTitle>{credits(balance)} AI credits</CardTitle>
        <CardDescription>
          AI answers, changelog drafts and code changes spend credits as they&apos;re used; what each spent is in{" "}
          <Link href={`/app/${slug}/settings/usage`} className="underline underline-offset-4">
            Usage
          </Link>
          . Credits that expire soonest are spent first.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {grants.length === 0 ? (
          <p className="text-sm text-muted-foreground">No credits left.</p>
        ) : (
          <table className="w-full text-sm" aria-label="AI credits left">
            <thead className="text-left text-xs text-muted-foreground">
              <tr>
                <th className="pb-2 font-medium">Credits</th>
                <th className="pb-2 text-right font-medium">Left</th>
                <th className="hidden pb-2 text-right font-medium sm:table-cell">Of</th>
                <th className="pb-2 text-right font-medium">Expires</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {grants.map((grant) => (
                <tr key={grant.id}>
                  <td className="py-2">
                    {SOURCES[grant.source]} <span className="text-muted-foreground">({day(grant.createdAt)})</span>
                  </td>
                  <td className="py-2 text-right tabular-nums">{credits(grant.remaining)}</td>
                  <td className="hidden py-2 text-right tabular-nums sm:table-cell">{credits(grant.credits)}</td>
                  <td className="py-2 text-right">{grant.expiresAt ? day(grant.expiresAt) : "Never"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </CardContent>
    </Card>
      )}
      {topupsEnabled() && (
        <Card>
          <CardHeader>
            <CardTitle>Buy credits</CardTitle>
            <CardDescription>Credits are added once the payment goes through.</CardDescription>
          </CardHeader>
          <CardContent>
            <BuyCredits projectSlug={slug} perDollar={creditsPerTopupDollar()} days={topupExpiryDays()} min={TOPUP_DOLLARS.min} max={TOPUP_DOLLARS.max} />
          </CardContent>
        </Card>
      )}
    </>
  );
}
