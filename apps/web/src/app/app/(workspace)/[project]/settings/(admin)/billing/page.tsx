import type { Metadata } from "next";
import { prisma } from "@tuti/db";
import { creditBalance, emailsThisMonth } from "@tuti/jobs";
import { badgeOffered, badgePrice, creditsEnabled, creditsPerTopupDollar, defaultPlanKey, effectivePlan, onDefaultPlan, planDisplay, planSalesEnabled, plansEnabled, topupExpiryDays, topupsEnabled, trialState } from "@tuti/shared";
import { notFound } from "next/navigation";

import { BuyCredits } from "@/components/buy-credits";
import { BadgeAddOn, ManagePlan, PlanPicker, UnassignLicense } from "@/components/plan-picker";
import { SettingBlock, SettingRow, SettingsCard, SettingsPane } from "@/components/settings-card";
import { UsageMonths } from "@/components/usage-months";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { buttonVariants } from "@/components/ui/button";
import { formatDate, formatShortDate } from "@/lib/format";
import { planPriceText } from "@/lib/plans";
import { plansWithFacts, pricingPage } from "@/lib/pricing-plans";
import { credits } from "@/lib/usage-format";
import { getAdminProject } from "@/server/membership";
import { TOPUP_DOLLARS } from "@/server/operations/credits";

export const metadata: Metadata = { title: "Billing · Settings" };

const LICENSE_SOURCES: Record<string, string> = { appsumo: "AppSumo", tuti: "Tuti" };

const SOURCES = { FREE: "Free credits", TOPUP: "Top-up", PLAN: "Plan", MANUAL: "Given by Tuti" } as const;


const sum = (grants: { credits: number; remaining: number }[], field: "credits" | "remaining") => grants.reduce((total, grant) => total + grant[field], 0);

/** One of This month's allowances: what's `left` `of` it, as a bar that empties; without a limit (`of` null), `used`. */
function Meter({ label, left, of, used }: { label: string; left: number | null; of: number | null; used?: string }) {
  return (
    <div className="flex flex-col gap-2 text-sm">
      <div className="flex justify-between gap-3">
        <span className="font-medium">{label}</span>
        {of === null || left === null ? (
          <span className="text-muted-foreground tabular-nums">{used}</span>
        ) : (
          <span className="tabular-nums">
            {`${credits(left)} `}
            <span className="text-muted-foreground">of {credits(of)}</span>
          </span>
        )}
      </div>
      {of !== null && left !== null && <Progress aria-label={`${label} left`} value={Math.min(left, of)} max={of} />}
    </div>
  );
}

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
        planLicense: { select: { id: true, source: true, revokedAt: true, creditsThrough: true } },
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
  // A license's AI credits for its month (they end with it, as its emails do: emails.until) are This month's, spent
  // ones too (the meter then reads 0); the rest (a trial's, the free ones, top-ups) are listed under it.
  // ponytail: a Stripe plan's credits stay in the list; into This month too when its period is a month, if asked for.
  // The license's month while it runs (its own: a plan with no email limit has it too): over and the next not given
  // yet (the hourly job late), there's none to show.
  const until = licensed && license?.creditsThrough && license.creditsThrough > new Date() ? license.creditsThrough : null;
  const monthly =
    licensed && until && creditsEnabled()
      ? (
          await prisma.creditGrant.findMany({
            where: { projectId: project.id, planLicenseId: license!.id, kind: "AI", expiresAt: until },
            select: { id: true, credits: true, remaining: true },
          })
        ).map((grant) => ({ id: grant.id, credits: grant.credits.toNumber(), remaining: grant.remaining.toNumber() }))
      : [];
  const extra = grants.filter((grant) => !monthly.some(({ id }) => id === grant.id));
  // What the project owes (a refund's credits already spent, a request that ran past the last): the balance has it
  // taken off, the meter and the list don't, so with a meter it's said.
  const owed = sum(monthly, "remaining") + sum(extra, "remaining") - balance;
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
      {plansEnabled() && licensed && license && (
        // A license's plan is one row: nothing to pay or renew, and unassigning it is rare, so behind "⋯".
        <SettingsCard>
          <div className="flex items-center gap-2.5 px-4 py-3 @min-[34rem]/settings:px-5">
            <h2 className="text-base font-semibold">{shown.name}</h2>
            <Badge variant="soft">{license.source === "appsumo" ? "Lifetime" : `${license.from} license`}</Badge>
            <div className="ml-auto">
              <UnassignLicense menu projectSlug={slug} licenseId={license.id} active badge={plan.badgeAddOn} />
            </div>
          </div>
        </SettingsCard>
      )}
      {plansEnabled() && !licensed && (
        <SettingsCard
          title={trial ? (trial.ended ? "Your trial has ended" : `${shown.name} trial`) : `${shown.name} plan`}
          description={
            trial
              ? trial.ended
                ? "Choose a plan to keep going. Plans are per project: readers are always unlimited."
                : `Ends on ${formatDate(trial.endsAt)}. Choose a plan to keep going.`
              : !onPaidPlan
                ? "Upgrade this project for more. Plans are per project: readers are always unlimited."
                : [
                    // None for a plan the file sells no way (by quote): it's billed as agreed.
                    shown.price[plan.planInterval === "year" ? "year" : "month"] !== null && planPriceText(shown.price, plan.planInterval === "year" ? "year" : "month"),
                    plan.planEndsAt ? `Ends on ${formatDate(plan.planEndsAt)}` : plan.planPeriodEnd && `Renews on ${formatDate(plan.planPeriodEnd)}`,
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
      {emails && (
        // What the plan gives each month, apart from the plan itself (a lifetime license's has no end; its month has).
        <SettingsCard>
          <SettingBlock>
            <div className="flex items-baseline justify-between gap-3">
              <h2 className="text-base font-semibold">This month</h2>
              {until && <span className="text-sm text-muted-foreground">Resets {formatShortDate(until)}</span>}
            </div>
            <div className="grid gap-4 @min-[34rem]/settings:grid-cols-2 @min-[34rem]/settings:gap-x-8">
              {/* A license's emails are its month's, wherever it was: what's left of them, not what this project sent. */}
              <Meter label="Emails" left={emails.left} of={emails.limit} used={`${emails.emails.toLocaleString("en")} sent`} />
              {monthly.length > 0 && <Meter label="AI credits" left={sum(monthly, "remaining")} of={sum(monthly, "credits")} />}
            </div>
            {monthly.length > 0 && owed >= 0.01 && <p className="text-sm text-muted-foreground">{credits(owed)} credits owed: new credits pay that first.</p>}
          </SettingBlock>
        </SettingsCard>
      )}
      {creditsEnabled() && (monthly.length === 0 || extra.length > 0) && (
        <SettingsCard>
          <SettingBlock>
            <h2 className="text-base font-semibold">{monthly.length > 0 ? "Extra AI credits" : `${credits(balance)} AI credits`}</h2>
            {extra.length === 0 ? (
              <p className="text-sm text-muted-foreground">No credits left.</p>
            ) : (
              <table className="w-full text-sm" aria-label="AI credits left">
                <thead className="sr-only">
                  <tr>
                    <th>Credits</th>
                    <th>Left</th>
                    <th>Expires</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {extra.map((grant) => (
                    <tr key={grant.id}>
                      <td className="w-1/3 py-2">{SOURCES[grant.source]}</td>
                      <td className="w-20 py-2 text-right tabular-nums">{credits(grant.remaining)}</td>
                      <td className="py-2 text-right text-muted-foreground">{grant.expiresAt ? `until ${formatShortDate(grant.expiresAt)}` : "Never"}</td>
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
      {plansEnabled() && (!license || licensed) && (badge !== null || plan.badgeAddOn) && (
        <SettingsCard>
          <SettingRow
            label='Hide "Powered by tuti"'
            description={
              licensed
                ? plan.badgeAddOn
                  ? "Hidden on this project, billed on its own. It ends with the license."
                  : `$${badge} a month, billed ${licensedBilling} on its own.`
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
      <UsageMonths projectId={project.id} />
    </SettingsPane>
  );
}
