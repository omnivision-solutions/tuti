import type { Metadata } from "next";
import { prisma } from "@tuti/db";
import { creditBalance, emailsThisMonth } from "@tuti/jobs";
import { badgeOffered, badgePrice, CREDIT_FEATURES, creditsEnabled, creditsPerTopupDollar, defaultPlanKey, effectivePlan, onDefaultPlan, planDisplay, planSalesEnabled, plansEnabled, topupExpiryDays, topupsEnabled, trialState } from "@tuti/shared";
import { notFound } from "next/navigation";

import { BuyCredits } from "@/components/buy-credits";
import { BadgeAddOn, ManagePlan, PlanPicker, UnassignLicense } from "@/components/plan-picker";
import { SettingBlock, SettingRow, SettingsCard, SettingsPane } from "@/components/settings-card";
import { UsageMonths } from "@/components/usage-months";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { buttonVariants } from "@/components/ui/button";
import { planPriceText } from "@/lib/plans";
import { plansWithFacts, pricingPage } from "@/lib/pricing-plans";
import { credits } from "@/lib/usage-format";
import { getAdminProject } from "@/server/membership";
import { TOPUP_DOLLARS } from "@/server/operations/credits";

export const metadata: Metadata = { title: "Billing · Settings" };

const LICENSE_SOURCES: Record<string, string> = { appsumo: "AppSumo", tuti: "Tuti" };

const SOURCES = { FREE: "Free credits", TOPUP: "Top-up", PLAN: "Plan", MANUAL: "Given by Tuti" } as const;

const day = (date: Date) => date.toLocaleDateString("en", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });

/**
 * Settings → Billing: the project's plan (where plans are sold), its AI credits (where AI is paid with
 * them: the balance, and what's left by when it expires), and what its AI use cost each month.
 */
export default async function BillingSettingsPage(props: PageProps<"/app/[project]/settings/billing">) {
  const { project: slug } = await props.params;
  const project = await getAdminProject(slug);
  if (!project) {
    notFound();
  }
  const [{ balance, grants }, plan, emails] = await Promise.all([
    creditsEnabled() ? creditBalance(project.id) : { balance: 0, grants: [] },
    prisma.project.findUniqueOrThrow({ where: { id: project.id }, select: {
        plan: true,
        planInterval: true,
        planStatus: true,
        planPeriodEnd: true,
        planEndsAt: true,
        badgeAddOn: true,
        trialEndsAt: true,
        planLicense: { select: { id: true, source: true, revokedAt: true } },
      },
    }),
    // Its email to its users this month, against its plan's limit (null without plans).
    emailsThisMonth(project.id),
  ]);
  // Back from Stripe's payment page: the credits or the plan come with Stripe's word that it's paid, usually within seconds.
  const searchParams = await props.searchParams;
  const paid = searchParams.paid === "1";
  const subscribed = searchParams.subscribed === "1";
  const badgeBought = searchParams.badge === "1";
  // The plan as stored (trialEndsAt selected: see @tuti/db), and a free trial of another while it runs.
  const trial = trialState(plan);
  const shown = planDisplay(effectivePlan(plan.plan, plan.trialEndsAt));
  // On a paid plan (a live subscription, or a plan the file sells set without one), or the default plan's (a trial's too).
  const onPaidPlan = plan.planStatus !== null || !onDefaultPlan(plan.plan);
  // The add-on as sold for a paid plan's billing (it bills alike); on the default plan, what it starts at. One that's on keeps
  // its card where it's no longer sold (its price stays listed, `sold: false`), so it can still be removed.
  const badge = badgeOffered(plan);
  // A plan license on the project (docs/plan.md, Plan licenses): its plan, not bought here, so no plan to manage in
  // Stripe (the add-on is bought on its own); or, revoked, the reason the project can't buy a plan until it's unassigned.
  const license = plan.planLicense && { ...plan.planLicense, from: LICENSE_SOURCES[plan.planLicense.source] ?? plan.planLicense.source };
  const licensed = Boolean(license && !license.revokedAt);
  // A licensed project's add-on is billed monthly where it's sold so, else yearly (plan.badge).
  const licensedBilling = badgePrice("month") ? "monthly" : "yearly";
  return (
    <SettingsPane title="Billing">
      {(paid || subscribed) && (
        <Alert>
          <AlertDescription>
            Thanks for your payment. Your {paid ? "credits show" : "plan starts"} here as soon as Stripe confirms it, usually within a few seconds.
          </AlertDescription>
        </Alert>
      )}
      {badgeBought && (
        <Alert>
          <AlertDescription>Thanks for your payment. &quot;Powered by tuti&quot; is hidden as soon as Stripe confirms it, usually within a few seconds.</AlertDescription>
        </Alert>
      )}
      {plansEnabled() && (
        <SettingsCard
          title={license && !license.revokedAt ? `${shown.name} plan` : trial ? (trial.ended ? "Your trial has ended" : `${shown.name} trial`) : `${shown.name} plan`}
          description={
            license && !license.revokedAt
              ? `Given by a license from ${license.from}${license.source === "appsumo" ? ", a lifetime deal" : ""}: it doesn't renew or bill.`
              : trial
              ? trial.ended
                ? "Choose a plan to keep going. Plans are per project: readers are always unlimited."
                : `Ends on ${day(trial.endsAt)}. Choose a plan to keep going.`
              : !onPaidPlan
                ? "Upgrade this project for more. Plans are per project: readers are always unlimited."
                : [
                    // None for a plan the file sells no way (by quote): it's billed as agreed.
                    shown.price[plan.planInterval === "year" ? "year" : "month"] !== null && planPriceText(shown.price, plan.planInterval === "year" ? "year" : "month"),
                    plan.planEndsAt ? `Ends on ${day(plan.planEndsAt)}` : plan.planPeriodEnd && `Renews on ${day(plan.planPeriodEnd)}`,
                  ]
                    .filter(Boolean)
                    .join(" · ")
          }
        >
          <SettingBlock>
            {plan.planStatus === "past_due" && (
              <Alert variant="destructive">
                <AlertDescription>The last payment didn&apos;t go through. Stripe tries again; update the card in Manage plan.</AlertDescription>
              </Alert>
            )}
            {emails && (
              <p className="text-sm text-muted-foreground">
                {emails.limit === null
                  ? `${emails.emails.toLocaleString("en")} emails sent this month`
                  : emails.until
                    ? // A license's emails are its month's, wherever it was: what this project sent says little.
                      `${emails.left!.toLocaleString("en")} of the license's ${emails.limit.toLocaleString("en")} emails left until ${day(emails.until)}`
                    : `${emails.emails.toLocaleString("en")} of ${emails.limit.toLocaleString("en")} emails sent this month`}
              </p>
            )}
            {license?.revokedAt && (
              <Alert variant="destructive">
                <AlertDescription>This project&apos;s {license.from} license was deactivated. {planSalesEnabled() ? "Unassign it to choose a plan." : "Unassign it to take it off this project."}</AlertDescription>
              </Alert>
            )}
            {license ? (
              <UnassignLicense projectSlug={slug} licenseId={license.id} active={!license.revokedAt} badge={plan.badgeAddOn} />
            ) : onPaidPlan ? (
              <ManagePlan projectSlug={slug} />
            ) : planSalesEnabled() ? (
              <PlanPicker projectSlug={slug} plans={plansWithFacts()} pricingPage={pricingPage()} current={defaultPlanKey()!} trial={trial?.ended === false} />
            ) : (
              <p id="plans-unavailable" tabIndex={-1} className="text-sm text-muted-foreground outline-none">
                Plans can&apos;t be bought here right now.
              </p>
            )}
          </SettingBlock>
        </SettingsCard>
      )}
      {plansEnabled() && (!license || licensed) && (badge !== null || plan.badgeAddOn) && (
        <SettingsCard>
          <SettingRow
            label='Hide "Powered by tuti"'
            description={
              licensed
                ? plan.badgeAddOn
                  ? "Hidden on this project, billed on its own. It ends with the license."
                  : `The badge at the foot of the portal: hide it for $${badge} a month, billed ${licensedBilling} on its own.`
                : plan.badgeAddOn
                ? // What it's billed at may be an older price than the file's: no amount.
                  "Hidden on this project's plan. It ends with the plan."
                : !onPaidPlan
                  ? `Paid plans can hide the badge at the foot of the portal for $${badge} a month.`
                  : `The badge at the foot of the portal: hide it for $${badge} a month, added to this project's plan.`
            }
          >
            {(plan.badgeAddOn || (planSalesEnabled() && badge !== null)) &&
              (!onPaidPlan && !licensed ? (
                // To the plans above, monthly or yearly as picked there.
                <a href="#plans" className={buttonVariants({ variant: "outline" })}>
                  Choose a plan
                </a>
              ) : (
                <div className="flex flex-wrap items-start gap-2">
                  <BadgeAddOn projectSlug={slug} on={plan.badgeAddOn} perMonth={badge ?? 0} licensed={licensed ? licensedBilling : undefined} />
                  {/* Its card and invoices: the add-on is the licensed project's only subscription. */}
                  {licensed && plan.badgeAddOn && <ManagePlan projectSlug={slug} />}
                </div>
              ))}
          </SettingRow>
        </SettingsCard>
      )}
      {creditsEnabled() && (
        <SettingsCard
          title={`${credits(balance)} AI credits`}
          description={
            <>
              {CREDIT_FEATURES} spend credits as they&apos;re used; what each spent is in{" "}
              <a href="#usage" className="underline underline-offset-4">
                Usage
              </a>
              . Credits that expire soonest are spent first.
            </>
          }
        >
          <SettingBlock>
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
          </SettingBlock>
        </SettingsCard>
      )}
      {topupsEnabled() && (
        <SettingsCard title="Buy credits" description="Credits are added once the payment goes through.">
          <SettingBlock>
            <BuyCredits projectSlug={slug} perDollar={creditsPerTopupDollar()} days={topupExpiryDays()} min={TOPUP_DOLLARS.min} max={TOPUP_DOLLARS.max} />
          </SettingBlock>
        </SettingsCard>
      )}
      <UsageMonths projectId={project.id} />
    </SettingsPane>
  );
}
