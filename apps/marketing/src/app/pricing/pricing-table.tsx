"use client";

import { buttonVariants } from "@tuti/ui/button";
import { BilledToggle } from "@tuti/ui/plan-line";
import { Popover, PopoverArrow, PopoverContent, PopoverTitle, PopoverTrigger } from "@tuti/ui/popover";
import { cn } from "cn";
import { BookOpenIcon, CheckIcon, ChevronDownIcon, InboxIcon, LightbulbIcon, SparklesIcon, UsersIcon } from "lucide-react";
import { type CSSProperties, type ReactNode, useState } from "react";

import { inApp, type PlanFacts, type Plans } from "../links";

type Plan = Plans["plans"][number];
type Interval = "month" | "year";

const number = (value: number | null) => (value === null ? "Unlimited" : value.toLocaleString("en"));
/** As a card's stats show a number: 10k, 100k from ten thousand up, smaller ones in full (1,000). */
const compact = (value: number | null) => (value !== null && value >= 10_000 ? `${(value / 1000).toLocaleString("en")}k` : number(value));
const days = (value: number | null) =>
  value === null ? "Unlimited" : value % 365 === 0 ? `${value / 365} ${value === 365 ? "year" : "years"}` : `${value} days`;
/** "a, b and c". */
const list = (items: string[]) => (items.length > 1 ? `${items.slice(0, -1).join(", ")} and ${items.at(-1)}` : (items[0] ?? ""));

/** What a month costs billed `interval` (the other way where it's sold only that way); null for a plan not sold. */
const perMonth = (plan: Plan, interval: Interval) => (plan.price ? (plan.price[interval] ?? plan.price.month ?? plan.price.year) : null);

/** The plans side by side, what every plan has, then (opened) every feature plan by plan, priced monthly or yearly as picked. */
export function PricingTable({ plans, yearlyNote }: { plans: Plan[]; yearlyNote: string | null }) {
  const [interval, setBilled] = useState<Interval>("month");
  const every = (has: (facts: PlanFacts) => boolean) => plans.every(({ facts }) => has(facts));
  const shared = [
    ...(every((facts) => facts.team === null) ? ["unlimited team members"] : []),
    "help center",
    ...(every((facts) => facts.aiAnswers) ? ["AI answers"] : []),
    ...(every((facts) => facts.features.codeChanges) ? ["Autopilot"] : []),
    "inbox",
    "feedback",
    "roadmap",
    "changelog",
  ];
  return (
    <section className="flex flex-col items-center gap-7">
      <BilledToggle value={interval} onChange={setBilled} yearlyNote={yearlyNote ?? undefined} />
      <ul className="grid w-full max-w-[520px] gap-5 lg:max-w-none lg:grid-cols-3">
        {plans.map((plan, index) => (
          <Card key={plan.name} plan={plan} previous={plans[index - 1]} interval={interval} credits={plans.some(({ facts }) => facts.credits !== null || facts.startCredits !== null)} />
        ))}
      </ul>
      <p className="text-center text-[15px] text-balance text-muted-foreground">
        <b className="font-semibold text-foreground">On every plan:</b> {list(shared)}.
      </p>
      {/* Native: the summary is a button that reads as expanded or collapsed, and opens with Enter or Space. */}
      <details className="group w-full">
        <summary className="mx-auto flex h-11 w-fit cursor-pointer list-none items-center gap-2 rounded-xl border border-input bg-card px-[22px] font-semibold group-open:mb-2 [&::-webkit-details-marker]:hidden">
          Compare all features
          <ChevronDownIcon aria-hidden className="size-[18px] transition-transform group-open:rotate-180" />
        </summary>
        <Comparison plans={plans} interval={interval} />
      </details>
    </section>
  );
}

function Card({ plan, previous, interval, credits }: { plan: Plan; previous?: Plan; interval: Interval; credits: boolean }) {
  const { facts } = plan;
  const more = previous ? yesNo(facts).filter(([text, has]) => has && !yesNo(previous.facts).some(([other, had]) => other === text && had)) : [];
  return (
    <li className={cn("flex flex-col gap-3.5 rounded-[18px] border bg-card p-5 sm:p-6", plan.featured && "border-primary shadow-[0_0_0_1px_var(--primary),0_18px_40px_-18px_color-mix(in_oklch,var(--primary)_35%,transparent)]")}>
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
      {/* The plan's three numbers, value above label. */}
      <dl className={cn("grid rounded-xl bg-muted px-1.5 py-3 text-center", credits ? "grid-cols-3" : "grid-cols-2")}>
        {[
          ...(credits ? [[<CreditsTip key="c" buy={facts.creditsBuy} credits={facts.credits} emails={facts.emails} label="credits a month" />, creditsCell(plan) || <NotIncluded />] as const] : []),
          ["feedback boards", compact(facts.boards)] as const,
          ["emails a month", compact(facts.emails)] as const,
        ].map(([label, value], index) => (
          <div key={index} className="flex flex-col-reverse items-center justify-end gap-0.5 px-1 not-first:border-l">
            <dt className="max-w-[76px] text-[13px] leading-tight text-muted-foreground">{label}</dt>
            {/* A word ("Unlimited", "By quote") smaller than a number, so it fits a third of the card. */}
            <dd className={cn("font-heading font-extrabold tracking-tight tabular-nums", typeof value === "string" && /[a-z]{2}/i.test(value) ? "text-base leading-[33px]" : "text-[22px]")}>
              {value}
            </dd>
          </div>
        ))}
      </dl>
      <div className="flex flex-1 flex-col gap-2 text-[15px] leading-snug">
        {previous ? (
          more.length > 0 && (
            <>
              <p className="font-semibold">Everything in {previous.name}, plus</p>
              <ul className="flex flex-col gap-2">
                {more.map(([text]) => (
                  <li key={text} className="flex gap-2.5">
                    <Check /> {text === "Private help center" ? <PrivateTip /> : text}
                  </li>
                ))}
              </ul>
            </>
          )
        ) : (
          <>
            {/* The whole product only where the plan has its AI too (Autopilot comes with AI answers). */}
            <p className="font-semibold">{facts.features.codeChanges ? "The whole product" : "Includes"}</p>
            <p className="text-muted-foreground">
              {list(["Help center", "inbox", "feedback", ...(facts.features.codeChanges ? ["Autopilot"] : facts.aiAnswers ? ["AI answers"] : [])])}
            </p>
          </>
        )}
      </div>
      {/* Last, after a growing list: the cards' buttons line up. */}
      <Cta plan={plan} className="mt-1 h-11 w-full text-base" />
    </li>
  );
}

/** A plan's yes/no lines, as its card lists what it adds: [text, whether the plan has it]. */
const yesNo = (facts: PlanFacts): [string, boolean][] => [
  ["Your own domain", facts.features.customDomain],
  ["Subpath on your domain", facts.features.sitePath],
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

/** A dotted-underlined label that opens a light card above it on hover, tap or focus. */
function Tip({ label, title, children }: { label: string; title: string; children: ReactNode }) {
  return (
    <Popover>
      <PopoverTrigger openOnHover delay={100} className="cursor-help underline decoration-foreground/45 decoration-dotted underline-offset-4">
        {label}
      </PopoverTrigger>
      <PopoverContent side="top" sideOffset={10} className="w-[280px] rounded-[14px] border bg-card px-4 py-3.5 text-left shadow-lg ring-0">
        {/* A square turned 45° with the card's fill and two edges, half hidden under the card. */}
        <PopoverArrow className="size-3 rotate-45 border bg-card data-[side=bottom]:-top-[7px] data-[side=bottom]:border-r-0 data-[side=bottom]:border-b-0 data-[side=top]:-bottom-[7px] data-[side=top]:border-t-0 data-[side=top]:border-l-0" />
        <PopoverTitle className="mb-2.5 font-heading text-[15px] font-bold">{title}</PopoverTitle>
        {children}
      </PopoverContent>
    </Popover>
  );
}

/**
 * "Credits a month", opening a rough idea of what credits buy: an estimate, as it depends on the model. Emails past the
 * included ones only where they spend credits: a plan with monthly credits and an email limit (emailsSpendCredits).
 */
function CreditsTip({ buy, credits, emails, label = "Credits a month" }: { buy: PlanFacts["creditsBuy"]; credits: number | null; emails: number | null; label?: string }) {
  const also = `screenshots of your app${credits !== null && emails !== null ? ", and emails past those your plan includes" : ""}`;
  const rows: [string, number][] = buy ? [["AI answers", buy.answers], ...(buy.changes !== null ? [["Or checked changes", buy.changes] as [string, number]] : [])] : [];
  return (
    <Tip label={label} title={credits !== null && buy ? `${number(credits)} credits buy about` : "What credits buy"}>
      {rows.length > 0 ? (
        <>
          <dl className="grid gap-2 text-sm">
            {rows.map(([label, value]) => (
              <div key={label} className="flex justify-between gap-3">
                <dt className="text-muted-foreground">{label}</dt>
                <dd className="font-bold tabular-nums">{number(value)}</dd>
              </div>
            ))}
          </dl>
          <p className="mt-2.5 border-t pt-2.5 text-xs text-muted-foreground">Estimates. They vary by question and model. Credits also pay for summaries, duplicate detection, {also}.</p>
        </>
      ) : (
        <p className="text-sm text-muted-foreground">Credits pay for AI answers, summaries, duplicate detection, Autopilot&apos;s checks of the changes you ship, {also}.</p>
      )}
    </Tip>
  );
}

const PrivateTip = () => (
  <Tip label="Private help center" title="Private help center">
    <p className="text-sm leading-snug text-muted-foreground">Show articles only to groups you choose, like paying customers.</p>
  </Tip>
);

/** A help center row's label with its example address under it, smaller. */
const WithExample = ({ label, example }: { label: string; example: string }) => (
  <span className="flex flex-col">
    {label}
    <small className="text-[13px] text-muted-foreground">{example}</small>
  </span>
);

/** A row's value on one plan: a number or text, or whether the plan has it. */
type Cell = string | boolean;
type Row = { label: ReactNode; cells: Cell[] };

/** The comparison's groups and rows, from each plan's facts. A row no plan has (or whose feature this server lacks) is left out. */
function groups(plans: Plan[]): { title: string; icon: ReactNode; rows: Row[] }[] {
  const row = (label: ReactNode, cell: (facts: PlanFacts, plan: Plan) => Cell): Row => ({ label, cells: plans.map((plan) => cell(plan.facts, plan)) });
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
        row(<WithExample label="Your own domain" example="help.yoursite.com" />, (facts) => facts.features.customDomain),
        row(<WithExample label="Subpath on your domain" example="yoursite.com/help" />, (facts) => facts.features.sitePath),
        row(<PrivateTip />, (facts) => facts.features.privatePortal),
      ],
    },
    {
      title: "AI",
      icon: <SparklesIcon aria-hidden className={icon} />,
      rows: [
        ...(plans.some(({ facts }) => facts.credits !== null || facts.startCredits !== null)
          ? [row(<CreditsTip buy={credited?.facts.creditsBuy ?? null} credits={credited?.facts.credits ?? null} emails={credited?.facts.emails ?? null} />, (_, plan) => creditsCell(plan))]
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

/** Every feature, plan by plan, a value in each plan's column. On phones each row's label sits above its values, so the plans keep the full width. */
function Comparison({ plans, interval }: { plans: Plan[]; interval: Interval }) {
  // Phones: a column a plan; wider: the labels, then a column a plan.
  const grid = "grid grid-cols-[repeat(var(--plans),minmax(0,1fr))] sm:grid-cols-[minmax(200px,1.3fr)_repeat(var(--plans),minmax(0,1fr))]";
  const tint = (index: number) => plans[index]?.featured && "bg-soft";
  return (
    <div role="table" aria-label="Plans compared" style={{ "--plans": plans.length } as CSSProperties}>
      <div role="row" className={cn(grid, "sticky top-16 z-10 border-b bg-background")}>
        {/* Hidden on phones but kept for screen readers, so each row's cells still line up with their plan. */}
        <div role="columnheader" className="max-sm:sr-only" />
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
          {rows.map(({ label, cells }, rowIndex) => (
            <div role="row" key={rowIndex} className={cn(grid, "border-b")}>
              <div role="rowheader" className="col-span-full flex items-center px-0.5 pt-3 text-[15px] text-muted-foreground sm:col-span-1 sm:px-1 sm:py-3 sm:text-foreground">
                {label}
              </div>
              {cells.map((cell, index) => (
                <div role="cell" key={index} className={cn("flex items-center justify-center px-1 pt-1.5 pb-3 text-center text-[15px] font-semibold sm:px-2 sm:py-3", tint(index))}>
                  {cell === true ? <CheckIcon role="img" aria-label="Included" className="size-4 text-primary" strokeWidth={2.5} /> : cell === false ? <NotIncluded /> : cell}
                </div>
              ))}
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

/** A dash that screen readers read as "Not included". */
function NotIncluded() {
  return (
    <span role="img" aria-label="Not included" className="text-muted-foreground">
      —
    </span>
  );
}

/** A plan's credits as the card and table show them: a month's, "By quote", the free plan's to start with, or false for none. */
function creditsCell({ byQuote, facts }: Plan): string | false {
  if (byQuote) return "By quote";
  if (facts.credits !== null) return number(facts.credits);
  return facts.startCredits !== null && `${number(facts.startCredits)} to start`;
}
