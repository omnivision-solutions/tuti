"use client";

import { buttonVariants } from "@tuti/ui/button";
import { BilledToggle } from "@tuti/ui/plan-line";
import { Popover, PopoverContent, PopoverTrigger } from "@tuti/ui/popover";
import { cn } from "cn";
import { BookOpenIcon, CheckIcon, InboxIcon, LightbulbIcon, SparklesIcon, UsersIcon } from "lucide-react";
import { type CSSProperties, type ReactNode, useState } from "react";

import { inApp, type PlanFacts, type Plans } from "../links";

type Plan = Plans["plans"][number];
type Interval = "month" | "year";

const number = (value: number | null) => (value === null ? "Unlimited" : value.toLocaleString("en"));
const days = (value: number | null) =>
  value === null ? "Unlimited" : value % 365 === 0 ? `${value / 365} ${value === 365 ? "year" : "years"}` : `${value} days`;

/** What a month costs billed `interval` (the other way where it's sold only that way); null for a plan not sold. */
const perMonth = (plan: Plan, interval: Interval) => (plan.price ? (plan.price[interval] ?? plan.price.month ?? plan.price.year) : null);

/** The plans side by side, then every feature plan by plan, priced monthly or yearly as picked. */
export function PricingTable({ plans, yearlyNote }: { plans: Plan[]; yearlyNote: string | null }) {
  const [interval, setBilled] = useState<Interval>("month");
  return (
    <>
      <section className="flex flex-col items-center gap-8">
        <BilledToggle value={interval} onChange={setBilled} yearlyNote={yearlyNote ?? undefined} />
        <ul className="grid w-full max-w-[520px] gap-5 lg:max-w-none lg:grid-cols-3">
          {plans.map((plan, index) => (
            <Card key={plan.name} plan={plan} previous={plans[index - 1]} interval={interval} credits={plans.some(({ facts }) => facts.credits !== null)} />
          ))}
        </ul>
      </section>
      <Comparison plans={plans} interval={interval} />
    </>
  );
}

function Card({ plan, previous, interval, credits }: { plan: Plan; previous?: Plan; interval: Interval; credits: boolean }) {
  const { facts } = plan;
  const more = previous ? yesNo(facts).filter(([text, has]) => has && !yesNo(previous.facts).some(([other, had]) => other === text && had)) : [];
  return (
    <li className={cn("flex flex-col gap-3.5 rounded-[18px] border bg-card p-[22px] sm:p-[26px]", plan.featured && "border-primary shadow-[0_0_0_1px_var(--primary),0_18px_40px_-18px_rgb(18_128_74/.35)]")}>
      <div className="flex items-center justify-between">
        <h2 className="font-heading text-[22px] font-bold tracking-tight">{plan.name}</h2>
        {plan.featured && <span className="rounded-full bg-soft px-2.5 py-0.5 text-[13px] font-semibold text-soft-foreground">Most popular</span>}
      </div>
      <p className="flex items-baseline gap-1.5">
        {plan.byQuote ? (
          <span className="font-heading text-5xl leading-none font-extrabold tracking-tight">By quote</span>
        ) : (
          <>
            <span className="font-heading text-5xl leading-none font-extrabold tracking-tight">${perMonth(plan, interval) ?? 0}</span>
            <span className="text-[15px] text-muted-foreground">{plan.price ? "a month per project" : "forever"}</span>
          </>
        )}
      </p>
      <p className="min-h-5 text-[15px] text-muted-foreground">
        {plan.price?.year != null && (interval === "year" || plan.price.month === null)
          ? `$${(plan.price.year * 12).toLocaleString("en")} billed yearly`
          : plan.price
            ? "Billed monthly"
            : plan.byQuote
              ? "Priced for your team"
              : "No card needed"}
      </p>
      <Cta plan={plan} className="h-11 w-full text-base" />
      <dl className="mt-1 flex flex-col text-[15px]">
        {[
          ...(credits ? [[<CreditsTip key="c" buy={facts.creditsBuy} credits={facts.credits} />, facts.credits === null ? "—" : number(facts.credits)] as const] : []),
          ["Feedback boards", number(facts.boards)] as const,
          ["Emails a month", number(facts.emails)] as const,
        ].map(([label, value], index) => (
          <div key={index} className="flex items-baseline justify-between gap-3 border-t py-2.5 last:border-b">
            <dt className="text-muted-foreground">{label}</dt>
            <dd className="text-[17px] font-bold tabular-nums">{value}</dd>
          </div>
        ))}
      </dl>
      {previous && more.length > 0 && (
        <>
          <p className="pt-1 text-[15px] font-semibold">Everything in {previous.name}, plus</p>
          <ul className="flex flex-col gap-2 text-[15px] leading-snug">
            {more.map(([text]) => (
              <li key={text} className="flex gap-2.5">
                <Check /> {text}
              </li>
            ))}
          </ul>
        </>
      )}
    </li>
  );
}

/** A plan's yes/no lines, as its card lists what it adds: [text, whether the plan has it]. */
const yesNo = (facts: PlanFacts): [string, boolean][] => [
  ["Your own domain", facts.features.customDomain],
  ["Help center at yoursite.com/help", facts.features.sitePath],
  ["Private help center", facts.features.privatePortal],
  ["AI answers", facts.aiAnswers],
  ["Autopilot", facts.features.codeChanges],
  ["Fine-tune Autopilot", facts.features.aiTuning],
  ["Email from your domain", facts.features.emailDomain],
  ...facts.extras.map((extra): [string, boolean] => [extra, true]),
];

/** Into the app (sign-up), or a `mailto:` for a plan by quote. Outline in the brand's colour: a plain outline on a card reads as disabled. */
function Cta({ plan, className }: { plan: Plan; className: string }) {
  return (
    <a
      href={inApp(plan.cta.href)}
      className={cn(buttonVariants({ variant: plan.featured ? "default" : "outline" }), !plan.featured && "border-primary/60 bg-card text-primary hover:text-primary", className)}
    >
      {plan.cta.label}
    </a>
  );
}

const Check = () => <CheckIcon aria-hidden className="mt-0.5 size-4 shrink-0 text-primary" strokeWidth={2.5} />;

/** "AI credits a month", opening a rough idea of what credits buy: an estimate, as it depends on the model. */
function CreditsTip({ buy, credits }: { buy: PlanFacts["creditsBuy"]; credits: number | null }) {
  return (
    <Popover>
      <PopoverTrigger openOnHover delay={100} className="cursor-help text-left underline decoration-foreground/45 decoration-dotted underline-offset-4">
        AI credits a month
      </PopoverTrigger>
      <PopoverContent side="top" className="w-72 bg-foreground p-3 text-[13px] leading-snug text-background ring-0">
        Credits pay for AI answers, summaries and Autopilot&apos;s checks of the changes you ship.
        {buy && credits !== null && (
          <>
            {" "}
            {number(credits)} credits buy about {number(buy.answers)} AI answers{buy.changes !== null && <>, or about {number(buy.changes)} checked changes</>}.
          </>
        )}{" "}
        An estimate: it depends on the question and the model.
      </PopoverContent>
    </Popover>
  );
}

/** A row's value on one plan: a number or text, or whether the plan has it. */
type Cell = string | boolean;
type Row = { label: ReactNode; cells: Cell[] };

/** The comparison's groups and rows, from each plan's facts. A row no plan has (or whose feature this server lacks) is left out. */
function groups(plans: Plan[]): { title: string; icon: ReactNode; rows: Row[] }[] {
  const row = (label: ReactNode, cell: (facts: PlanFacts) => Cell): Row => ({ label, cells: plans.map(({ facts }) => cell(facts)) });
  const credited = plans.find(({ facts }) => facts.creditsBuy);
  const extras = [...new Set(plans.flatMap(({ facts }) => facts.extras))];
  const icon = "size-5 text-primary";
  return [
    {
      title: "Help center",
      icon: <BookOpenIcon aria-hidden className={icon} />,
      rows: [
        row("Published articles", (facts) => number(facts.articles)),
        row("Versions kept per article", (facts) => number(facts.versions)),
        row("Your own domain", (facts) => facts.features.customDomain),
        row("At yoursite.com/help", (facts) => facts.features.sitePath),
        row("Private help center", (facts) => facts.features.privatePortal),
      ],
    },
    {
      title: "AI",
      icon: <SparklesIcon aria-hidden className={icon} />,
      rows: [
        ...(plans.some(({ facts }) => facts.credits !== null)
          ? [row(<CreditsTip buy={credited?.facts.creditsBuy ?? null} credits={credited?.facts.credits ?? null} />, (facts) => (facts.credits === null ? false : number(facts.credits)))]
          : []),
        row("AI answers", (facts) => facts.aiAnswers),
        row("Autopilot", (facts) => facts.features.codeChanges),
        row("Fine-tune Autopilot", (facts) => facts.features.aiTuning),
      ],
    },
    {
      title: "Inbox",
      icon: <InboxIcon aria-hidden className={icon} />,
      rows: [
        row("Emails a month", (facts) => number(facts.emails)),
        row("Inbox history", (facts) => days(facts.historyDays)),
        row("Chat widget", () => true),
        row("Email from your domain", (facts) => facts.features.emailDomain),
      ],
    },
    {
      title: "Feedback",
      icon: <LightbulbIcon aria-hidden className={icon} />,
      rows: [row("Boards", (facts) => number(facts.boards)), row("Posts and votes", () => "Unlimited"), row("Roadmap and changelog", () => true)],
    },
    {
      title: "Team",
      icon: <UsersIcon aria-hidden className={icon} />,
      rows: [row("Team members", (facts) => number(facts.team)), row("End users", () => "Unlimited"), ...extras.map((extra) => row(extra, (facts) => facts.extras.includes(extra)))],
    },
  ].map((group) => ({ ...group, rows: group.rows.filter(({ cells }) => cells.some((cell) => cell !== false)) }));
}

/**
 * Every feature, plan by plan. A row the same on every plan is one bar across them ("✓ Every plan"). On phones each row's
 * label sits above its values, so the plans keep the full width.
 */
function Comparison({ plans, interval }: { plans: Plan[]; interval: Interval }) {
  // Phones: a column a plan; wider: the labels, then a column a plan.
  const grid = "grid grid-cols-[repeat(var(--plans),minmax(0,1fr))] sm:grid-cols-[minmax(200px,1.3fr)_repeat(var(--plans),minmax(0,1fr))]";
  const tint = (index: number) => plans[index]?.featured && "bg-soft";
  return (
    <section style={{ "--plans": plans.length } as CSSProperties}>
      <h2 className="mb-4 text-center font-heading text-[26px] font-extrabold tracking-tight sm:text-[32px]">Everything, plan by plan</h2>
      <div role="table" aria-label="Plans compared">
        <div role="row" className={cn(grid, "sticky top-16 z-10 border-b bg-background")}>
          <div role="columnheader" className="max-sm:hidden" />
          {plans.map((plan, index) => {
            const price = perMonth(plan, interval);
            return (
              <div role="columnheader" key={plan.name} className={cn("flex flex-col items-center gap-1.5 px-1 pt-3 pb-2.5 text-center sm:px-2.5 sm:pt-4 sm:pb-3.5", tint(index), plan.featured && "rounded-t-[14px]")}>
                <b className="font-heading text-[17px] font-bold sm:text-xl">{plan.name}</b>
                <span className="text-sm text-muted-foreground sm:text-[15px]">{plan.byQuote ? "By quote" : price === null ? "Free" : `$${price} a month`}</span>
                <Cta plan={plan} className="h-9 px-3.5 text-[15px] max-sm:hidden" />
              </div>
            );
          })}
        </div>
        {groups(plans).map(({ title, icon, rows }) => (
          <div role="rowgroup" key={title}>
            <div role="row" className="flex items-center gap-2.5 border-b px-1 pt-6 pb-2.5 font-heading text-lg font-bold sm:pt-7 sm:text-xl">
              <span role="rowheader" className="flex items-center gap-2.5">
                {icon}
                {title}
              </span>
            </div>
            {rows.map(({ label, cells }, rowIndex) => {
              const same = cells.every((cell) => cell === cells[0]);
              return (
                <div role="row" key={rowIndex} className={cn(grid, "border-b")}>
                  <div role="rowheader" className="col-span-full flex items-center px-0.5 pt-3 text-[15px] text-muted-foreground sm:col-span-1 sm:px-1 sm:py-3 sm:text-foreground">
                    {label}
                  </div>
                  {same ? (
                    <div role="cell" aria-colspan={plans.length} className="col-span-full my-1.5 mb-2.5 flex items-center justify-center gap-2 rounded-lg bg-soft/55 px-2 py-1.5 text-[15px] font-medium text-soft-foreground sm:col-[2/-1] sm:mb-1.5">
                      <CheckIcon aria-hidden className="size-4 text-primary" strokeWidth={2.5} />
                      {cells[0] === true ? "Every plan" : cells[0] === "Unlimited" ? "Unlimited on every plan" : `${String(cells[0])} on every plan`}
                    </div>
                  ) : (
                    cells.map((cell, index) => (
                      <div role="cell" key={index} className={cn("flex items-center justify-center px-1 pt-1.5 pb-3 text-center text-[15px] font-semibold sm:px-2 sm:py-3", tint(index))}>
                        {cell === true ? (
                          <CheckIcon role="img" aria-label="Included" className="size-4 text-primary" strokeWidth={2.5} />
                        ) : cell === false ? (
                          <span aria-label="Not included" className="text-input">
                            —
                          </span>
                        ) : (
                          cell
                        )}
                      </div>
                    ))
                  )}
                </div>
              );
            })}
          </div>
        ))}
      </div>
    </section>
  );
}
