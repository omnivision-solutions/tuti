import type { Metadata } from "next";
import { prisma } from "@tuti/db";
import { creditBalance, emailsThisMonth } from "@tuti/jobs";
import { badgeOffered, badgePrice, boardLimit, creditsEnabled, creditsPerTopupDollar, defaultPlanKey, effectivePlan, onDefaultPlan, planDisplay, planSalesEnabled, plansEnabled, topupExpiryDays, topupsEnabled, trialState } from "@tuti/shared";
import { notFound } from "next/navigation";

import { BuyCredits } from "@/components/buy-credits";
import { BadgeAddOn, ManagePlan, UnassignLicense, UpgradePlans } from "@/components/plan-picker";
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

/** One of the card's allowances: what's `left` `of` it, as a bar that empties; without a limit (`of` null), `used`. */
function Meter({ label, left, of, used }: { label: string; left: number | null; of: number | null; used?: string }) {
  return (
    <div role="group" aria-label={label} className="flex flex-col gap-2 text-sm">
      <div className="flex flex-wrap justify-between gap-x-3">
        <span className="font-medium">{label}</span>
        {of === null || left === null ? (
          <span className="text-muted-foreground tabular-nums">{used}</span>
        ) : (
          <span className="tabular-nums">
            {`${credits(left)} `}
            <span className="text-muted-foreground">of {credits(of)} left</span>
          </span>
        )}
      </div>
      {of !== null && left !== null && <Progress aria-label={`${label} left`} value={Math.max(0, Math.min(left, of))} max={of} />}
    </div>
  );
}

/**
 * Settings → Billing: the project's plan, one row (where plans are sold; on the default plan "Upgrade" opens the plans
 * to buy), this month's emails (and a license's month's AI credits), its AI credits (where AI is paid with them: the
 * balance, what's left by when it expires, and buying more), the add-on, and what its AI use cost each month.
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
  const until = emails && licensed && license?.creditsThrough && license.creditsThrough > new Date() ? license.creditsThrough : null;
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
  // What gave a plan's credits ("Starter trial", "Pro plan": the grant's note, written by Tuti), so two of them aren't
  // both "Plan". Other notes are the operator's own (credits given by hand), and stay theirs.
  const titles = new Map(
    (await prisma.creditGrant.findMany({ where: { id: { in: extra.filter(({ source }) => source === "PLAN").map(({ id }) => id) }, note: { not: "" } }, select: { id: true, note: true } })).map(
      ({ id, note }) => [id, note],
    ),
  );
  // What the project owes (a refund's credits already spent, a request that ran past the last): the balance has it
  // taken off, the meter and the list don't, so with a meter it's said.
  const owed = sum(monthly, "remaining") + sum(extra, "remaining") - balance;
  // The credits that aren't a license's month's: all of them without one, else the rest where there are any.
  const showCredits = creditsEnabled() && (monthly.length === 0 || extra.length > 0);
  // The default plan's room for feedback boards, said beside its emails.
  const boards = boardLimit(effectivePlan(plan.plan, plan.trialEndsAt));
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
        <SettingsCard title="Plan">
          {plan.planStatus === "past_due" && !licensed && (
            <SettingBlock>
              <Alert variant="destructive">
                <AlertDescription>The last payment didn&apos;t go through. Stripe tries again; update the card in Manage plan.</AlertDescription>
              </Alert>
            </SettingBlock>
          )}
          {license?.revokedAt && (
            <SettingBlock>
              <Alert variant="destructive">
                <AlertDescription>This project&apos;s {license.from} license was deactivated. {planSalesEnabled() ? "Unassign it to choose a plan." : "Unassign it to take it off this project."}</AlertDescription>
              </Alert>
            </SettingBlock>
          )}
          <SettingRow
            inline
            label={
              <span className="flex flex-wrap items-center gap-2">
                <span>{shown.name}</span>
                {licensed && license ? (
                  <Badge variant="soft">{license.source === "appsumo" ? "Lifetime" : `${license.from} license`}</Badge>
                ) : (
                  <Badge variant="secondary">{trial ? (trial.ended ? "Trial ended" : "Trial") : "Your plan"}</Badge>
                )}
              </span>
            }
            description={
              // A license's plan has nothing to pay or renew.
              licensed ? undefined : !license && !onPaidPlan && !planSalesEnabled() ? (
                // No Upgrade to offer (a trial's too): said, where UnassignLicense moves the keyboard to.
                <>
                  {trial?.ended === false && `Ends on ${formatDate(trial.endsAt)}. `}
                  <span id="plans-unavailable" tabIndex={-1} className="outline-none">
                    Plans can&apos;t be bought here right now.
                  </span>
                </>
              ) : trial?.ended === false ? (
                `Ends on ${formatDate(trial.endsAt)}`
              ) : !onPaidPlan ? (
                // What the plan gives, where it has limits.
                [emails && emails.limit !== null && `${emails.limit.toLocaleString("en")} emails a month`, boards !== null && `${boards} feedback ${boards === 1 ? "board" : "boards"}`].filter(Boolean).join(" · ")
              ) : (
                [
                  // None for a plan the file sells no way (by quote): it's billed as agreed.
                  shown.price[plan.planInterval === "year" ? "year" : "month"] !== null && planPriceText(shown.price, plan.planInterval === "year" ? "year" : "month"),
                  plan.planEndsAt ? `Ends on ${formatDate(plan.planEndsAt)}` : plan.planPeriodEnd && `Renews on ${formatDate(plan.planPeriodEnd)}`,
                ]
                  .filter(Boolean)
                  .join(" · ")
              )
            }
          >
            {license ? (
              // Unassigning a license that gives its plan is rare, so behind "⋯".
              <UnassignLicense menu={licensed} projectSlug={slug} licenseId={license.id} active={licensed} badge={plan.badgeAddOn} />
            ) : onPaidPlan ? (
              <ManagePlan projectSlug={slug} />
            ) : planSalesEnabled() ? (
              <UpgradePlans projectSlug={slug} plans={plansWithFacts()} pricingPage={pricingPage()} current={defaultPlanKey()!} trial={trial?.ended === false} />
            ) : null}
          </SettingRow>
        </SettingsCard>
      )}
      {emails && (
        // What the plan gives each month, apart from the plan itself (a lifetime license's has no end; its month has).
        <SettingsCard
          title="This month"
          // The day the license's month ends, where something here follows it (emails counted against a limit, its credits).
          action={until && (emails.limit !== null || monthly.length > 0) && <span className="text-sm text-muted-foreground">Resets {formatShortDate(until)}</span>}
        >
          <SettingBlock>
            {/* A license's emails are its month's, wherever it was: what's left of them, not what this project sent. */}
            {/* Without a limit they're a calendar month's (UTC): said where the card's reset day is the license's. */}
            <Meter
              label="Emails"
              left={emails.left}
              of={emails.limit}
              used={`${emails.emails.toLocaleString("en")} sent${until ? ` since ${formatShortDate(new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1)))}` : ""}`}
            />
          </SettingBlock>
          {monthly.length > 0 && (
            <SettingBlock>
              <Meter label="AI credits" left={sum(monthly, "remaining")} of={sum(monthly, "credits")} />
              {/* The next AI request takes what's owed from the credits there (chargeCredits); with none over, AI is paused (aiPaused). */}
              {owed >= 0.01 && (
                <p className="text-sm text-muted-foreground">
                  {balance <= 0 ? `AI is paused: this project owes ${credits(owed)} credits.` : `${credits(owed)} credits owed, taken at the next AI use.`}
                </p>
              )}
            </SettingBlock>
          )}
        </SettingsCard>
      )}
      {(showCredits || topupsEnabled()) && (
        // The credits that last past the month (a trial's, the free ones, top-ups), beside where more are bought. With
        // only a license's month's, buying more is all there is: no title.
        <SettingsCard title={monthly.length === 0 ? "AI credits" : extra.length > 0 ? "Extra AI credits" : undefined}>
          {showCredits && (
            <SettingBlock className="gap-2">
              {/* The balance (what's owed taken off, never below none: what's owed is said under it), of what the credits listed under it started as. */}
              {monthly.length === 0 && <Meter label="Balance" left={extra.length > 0 ? Math.max(balance, 0) : null} of={extra.length > 0 ? sum(extra, "credits") : null} used="No credits left." />}
              {/* More owed than is left (a request that ran past the last credit): what the next credits pay first. */}
              {monthly.length === 0 && balance <= -0.01 && <p className="text-sm text-muted-foreground">AI is paused: this project owes {credits(-balance)} credits.</p>}
              {extra.length > 0 && (
                <table className="w-full text-sm text-muted-foreground" aria-label="AI credits left">
                  <thead className="sr-only">
                    <tr>
                      <th>Credits</th>
                      <th>Left</th>
                      <th>Expires</th>
                    </tr>
                  </thead>
                  <tbody>
                    {extra.map((grant) => (
                      <tr key={grant.id}>
                        <td className="w-1/3 py-1">{titles.get(grant.id) ?? SOURCES[grant.source]}</td>
                        <td className="w-20 py-1 text-right tabular-nums">{credits(grant.remaining)}</td>
                        <td className="py-1 text-right">{grant.expiresAt ? `until ${formatShortDate(grant.expiresAt)}` : "Never"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </SettingBlock>
          )}
          {topupsEnabled() && <BuyCredits projectSlug={slug} perDollar={creditsPerTopupDollar()} days={topupExpiryDays()} min={TOPUP_DOLLARS.min} max={TOPUP_DOLLARS.max} />}
        </SettingsCard>
      )}
      {plansEnabled() && (!license || licensed) && (badge !== null || plan.badgeAddOn) && (
        <SettingsCard title="Add-ons">
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
                  ? `$${badge} a month, on a paid plan.`
                  : `$${badge} a month, added to this project's plan.`
            }
          >
            {(plan.badgeAddOn || (planSalesEnabled() && badge !== null)) &&
              (!onPaidPlan && !licensed ? (
                // Opens the plans (UpgradePlans), monthly or yearly as picked there.
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
