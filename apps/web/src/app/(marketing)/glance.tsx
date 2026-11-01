import { plansEnabled } from "@tuti/shared";
import {
  ArrowRightIcon,
  ArrowRightLeftIcon,
  BookOpenIcon,
  ChartColumnIcon,
  CheckIcon,
  GlobeIcon,
  HistoryIcon,
  LightbulbIcon,
  LockIcon,
  MegaphoneIcon,
  MessageCircleIcon,
  SearchIcon,
  SparklesIcon,
} from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";

import { GithubMark } from "@/components/github-mark";
import { PostStatusBadge } from "@/components/post-status-badge";
import { TutiMark } from "@/components/tuti-logo";
import { buttonVariants } from "@/components/ui/button";
import { PLAN_PRICES } from "@/lib/plans";
import { cn } from "@/lib/utils";

import { REPO_URL } from "./links";

/**
 * The landing page's sections (app/(marketing)/page.tsx): outcomes up front, pictures doing the
 * talking, a few words each. How Tuti notices a change lives in the FAQ, not the headlines.
 */

/** A section's content column. */
const WRAP = "mx-auto w-full max-w-6xl px-6";

const big = "h-11 px-5 text-base";

function Eyebrow({ children, green = false }: { children: ReactNode; green?: boolean }) {
  return (
    <p
      className={cn(
        "inline-flex items-center gap-2 text-xs font-bold tracking-wider uppercase before:h-0.5 before:w-4.5 before:rounded-full before:bg-current",
        green ? "text-soft-foreground" : "text-highlight-foreground",
      )}
    >
      {children}
    </p>
  );
}

/** The two buttons every call to action has. `start`: the app when signed in, else sign-up. */
function Ctas({ start, docs, className }: { start: string; docs: string; className?: string }) {
  return (
    <div className={cn("flex flex-wrap justify-center gap-3", className)}>
      <Link href={start} className={buttonVariants({ size: "lg", className: big })}>
        Start free
      </Link>
      <a href={docs} className={buttonVariants({ size: "lg", variant: "outline", className: big })}>
        {docs.startsWith(REPO_URL) ? "Read the docs" : "See a live help center"}
      </a>
    </div>
  );
}

function Tick({ className }: { className?: string }) {
  return (
    <span aria-hidden className={cn("flex size-4.5 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground", className)}>
      <CheckIcon className="size-3" strokeWidth={3.5} />
    </span>
  );
}

/** A centred headline, one line under it, the buttons, then the picture. */
export function GlanceHero({ title, lead, start, docs, children }: { title: ReactNode; lead: ReactNode; start: string; docs: string; children: ReactNode }) {
  return (
    <section className="landing-dots relative overflow-hidden">
      <div aria-hidden className="landing-glow-center pointer-events-none absolute inset-0" />
      <div className={cn(WRAP, "relative pt-16 pb-20 text-center lg:pt-24")}>
        <h1 className="mx-auto max-w-4xl text-5xl font-extrabold tracking-tight text-balance sm:text-6xl lg:text-7xl">{title}</h1>
        <p className="mx-auto mt-5 max-w-2xl text-lg text-muted-foreground text-pretty sm:text-xl">{lead}</p>
        <Ctas start={start} docs={docs} className="mt-8" />
        <div className="mt-14 text-left">{children}</div>
      </div>
    </section>
  );
}

/** A soft frame around a product picture. */
function Frame({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={cn("rounded-3xl border bg-linear-to-br from-soft via-card to-highlight/60 p-2 shadow-2xl sm:p-3", className)}>
      <div className="overflow-hidden rounded-2xl border bg-card">{children}</div>
    </div>
  );
}

/** Faces of the people a feature request tells. */
function Faces({ count }: { count: number }) {
  const faces = [
    ["S", "bg-primary text-primary-foreground"],
    ["M", "bg-highlight text-highlight-foreground"],
    ["J", "bg-soft text-soft-foreground"],
    ["A", "bg-foreground text-background"],
  ];
  return (
    <span className="flex items-center gap-2">
      <span className="flex -space-x-1.5">
        {faces.map(([letter, colour]) => (
          <span key={letter} className={cn("flex size-6 items-center justify-center rounded-full text-[11px] font-bold ring-2 ring-card", colour)}>
            {letter}
          </span>
        ))}
      </span>
      <span className="text-xs font-semibold">{count} told</span>
    </span>
  );
}

/** The old line struck out, the new one in. */
function Diff({ from, to }: { from: string; to: string }) {
  return (
    <span className="flex flex-col gap-1 text-sm">
      <del className="w-fit rounded-md bg-destructive/10 px-2 py-0.5 text-destructive">{from}</del>
      <ins className="w-fit rounded-md bg-soft px-2 py-0.5 text-soft-foreground no-underline">{to}</ins>
    </span>
  );
}

/** A feature request moving from Planned to Completed. */
function StatusFlip() {
  return (
    <span className="flex items-center gap-2">
      <span className="opacity-50">
        <PostStatusBadge status="PLANNED" />
      </span>
      <ArrowRightIcon aria-hidden className="size-3.5 text-muted-foreground" />
      <PostStatusBadge status="COMPLETED" />
    </span>
  );
}

/** The hero's picture: everything around the product, current, and what Autopilot just did. */
export function UpToDateBoard() {
  const updates: { icon: typeof BookOpenIcon; kind: string; title: string; change: ReactNode; when: string }[] = [
    { icon: BookOpenIcon, kind: "Help article", title: "Exporting data", change: <Diff from="Open Settings → Billing" to="Open Settings → Data" />, when: "Updated 2h ago" },
    {
      icon: LightbulbIcon,
      kind: "Feature request",
      title: "Dark mode",
      change: (
        <span className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <StatusFlip />
          <Faces count={128} />
        </span>
      ),
      when: "Shipped today",
    },
    { icon: MegaphoneIcon, kind: "Changelog", title: "Dark mode is here", change: <span className="text-sm text-muted-foreground">Added to your next entry.</span>, when: "Drafted" },
  ];
  return (
    <figure
      aria-label="Acme's help center, AI answers, roadmap and changelog, all up to date. Tuti just rewrote the article Exporting data, marked Dark mode completed and told the 128 people who asked, and added a line to the next changelog entry. The AI now answers from the updated article."
      className="relative mx-auto max-w-5xl"
    >
      <Frame>
        <div aria-hidden className="flex flex-wrap items-center gap-3 border-b px-4 py-3">
          <TutiMark className="size-5.5" />
          <span className="font-bold">Acme</span>
          <span className="ml-auto flex items-center gap-2 rounded-full bg-soft px-3 py-1 text-sm font-semibold text-soft-foreground">
            <Tick /> Everything up to date
          </span>
        </div>
        <div aria-hidden className="grid gap-px bg-border sm:grid-cols-4">
          {["Help center", "AI answers", "Roadmap", "Changelog"].map((part) => (
            <p key={part} className="flex items-center gap-2 bg-card px-4 py-3 text-sm font-semibold">
              <Tick className="landing-tick" /> {part}
            </p>
          ))}
        </div>
        <div aria-hidden className="grid gap-5 border-t p-4 sm:p-6 lg:grid-cols-[1fr_19rem]">
          <ul className="flex flex-col gap-3">
            {updates.map(({ icon: Icon, kind, title, change, when }) => (
              <li key={kind} className="flex min-w-0 gap-3.5 rounded-xl border bg-background p-4">
                <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-soft text-soft-foreground">
                  <Icon className="size-4.5" />
                </span>
                <div className="flex min-w-0 flex-1 flex-col gap-2">
                  <p className="flex flex-wrap items-baseline justify-between gap-x-3">
                    <span className="font-semibold">
                      {title} <span className="ml-1 text-xs font-normal text-muted-foreground">{kind}</span>
                    </span>
                    <span className="flex items-center gap-1 text-xs font-semibold text-soft-foreground">
                      <SparklesIcon className="size-3.5" /> {when}
                    </span>
                  </p>
                  {change}
                </div>
              </li>
            ))}
          </ul>
          <div className="flex flex-col gap-3 rounded-xl border bg-background p-4">
            <p className="flex items-center gap-2 text-sm font-bold">
              <SparklesIcon className="size-4 text-primary" /> Ask AI
            </p>
            <p className="ml-auto w-fit rounded-2xl rounded-br-sm bg-primary px-3.5 py-2 text-sm text-primary-foreground">How do I export my data?</p>
            <div className="rounded-2xl rounded-bl-sm bg-muted px-3.5 py-3 text-sm">
              Open <strong>Settings → Data</strong> and click Export CSV.
              <p className="mt-2 flex items-center gap-1.5 text-xs font-semibold text-soft-foreground">
                <Tick className="size-3.5" /> From “Exporting data”, updated 2h ago
              </p>
            </div>
          </div>
        </div>
      </Frame>
    </figure>
  );
}

/** The problem in one look: what changed this week, and what still says otherwise. */
export function StaleBand() {
  const changes = ["renamed a plan.", "moved a button.", "shipped dark mode."];
  const stale = [
    ["Help article", "5 months old"],
    ["AI answer", "wrong, and sure"],
    ["Feature request", "still “Planned”"],
  ];
  return (
    <section className="border-y bg-muted/40">
      <div className={cn(WRAP, "grid items-center gap-10 py-20 lg:grid-cols-[1.2fr_1fr] lg:py-24")}>
        <div>
          <Eyebrow>Sound familiar?</Eyebrow>
          <h2 className="mt-4 text-4xl font-extrabold tracking-tight sm:text-5xl">
            This week you
            <span className="relative mt-1 block h-[1.15em]">
              {changes.map((change, i) => (
                <span
                  key={change}
                  aria-hidden
                  className="landing-rotate absolute inset-x-0 top-0 whitespace-nowrap text-highlight-foreground"
                  style={{ animationDelay: `${i * 4}s` }}
                >
                  {change}
                </span>
              ))}
              <span className="sr-only">{changes[0]}</span>
            </span>
          </h2>
          <p className="mt-5 text-xl text-muted-foreground">Your help center still says otherwise.</p>
        </div>
        <ul aria-label="What's out of date" className="flex flex-col gap-3">
          {stale.map(([where, age]) => (
            <li key={where} className="flex items-center justify-between gap-4 rounded-xl border bg-card px-5 py-4">
              <span className="font-semibold">{where}</span>
              <span className="rounded-full bg-highlight px-3 py-1 text-sm font-bold text-highlight-foreground">{age}</span>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}

/** Autopilot: what keeps itself current, one picture each. */
export function AutoCards() {
  const cards: { title: string; text: string; picture: ReactNode }[] = [
    {
      title: "Articles fix themselves",
      text: "Stale steps rewritten to match what shipped.",
      picture: (
        <div className="flex flex-col gap-2">
          <p className="font-semibold">Exporting data</p>
          <Diff from="Open Settings → Billing" to="Open Settings → Data" />
        </div>
      ),
    },
    {
      title: "Feature requests, closed out",
      text: "Marked shipped, and everyone who asked hears about it.",
      picture: (
        <div className="flex flex-col gap-3">
          <p className="flex items-center justify-between gap-2 font-semibold">
            Dark mode <span className="text-xs font-normal text-muted-foreground">128 votes</span>
          </p>
          <StatusFlip />
          <Faces count={128} />
        </div>
      ),
    },
    {
      title: "Changelog, drafted",
      text: "Every change you ship, lined up in your next entry.",
      picture: (
        <div className="flex flex-col gap-1.5 text-sm">
          <p className="text-xs font-semibold text-muted-foreground">Draft · Next release</p>
          <p className="flex items-center gap-2 rounded-md bg-soft px-2 py-1 font-semibold text-soft-foreground">
            <SparklesIcon className="size-3.5 shrink-0" /> Dark mode is here
          </p>
          <p className="px-2 text-muted-foreground">Export moved to Settings → Data</p>
          <p className="px-2 text-muted-foreground">Faster search</p>
        </div>
      ),
    },
  ];
  return (
    <section aria-labelledby="autopilot" className={cn(WRAP, "py-20 lg:py-28")}>
      <div className="mx-auto max-w-3xl text-center">
        <Eyebrow green>Autopilot</Eyebrow>
        <h2 id="autopilot" className="mt-3 text-4xl font-extrabold tracking-tight text-balance sm:text-5xl">
          Always up to date. Zero busywork.
        </h2>
      </div>
      <ul className="mt-12 grid gap-5 md:grid-cols-3">
        {cards.map((card) => (
          // Subgrid: the pictures share one row height, so the titles under them line up.
          <li key={card.title} className="row-span-2 grid min-w-0 grid-rows-subgrid gap-0 overflow-hidden rounded-2xl border bg-card">
            <div aria-hidden className="landing-dots flex min-h-44 items-center justify-center bg-linear-to-b from-soft/70 to-card p-6">
              <div className="w-full max-w-64 rounded-xl border bg-background p-4 shadow-lg">{card.picture}</div>
            </div>
            <div className="p-6 pt-5">
              <h3 className="text-xl font-bold">{card.title}</h3>
              <p className="mt-1 text-muted-foreground">{card.text}</p>
            </div>
          </li>
        ))}
      </ul>
      <ul className="mt-8 flex flex-wrap justify-center gap-x-6 gap-y-2 text-sm font-medium text-muted-foreground">
        {["Approve it, or let it go live after a review window", "Stop anything before it goes live"].map((point) => (
          <li key={point} className="flex items-center gap-2">
            <Tick /> {point}
          </li>
        ))}
      </ul>
    </section>
  );
}

/** The help center itself: what a customer sees, and what a buyer checks for. */
export function HelpFeatures() {
  const features: { icon: typeof GlobeIcon; title: string; text: string }[] = [
    { icon: SparklesIcon, title: "AI answers", text: "Instant answers, with sources." },
    { icon: MessageCircleIcon, title: "In-app widget", text: "Help inside your product." },
    { icon: GlobeIcon, title: "Your domain and brand", text: "help.acme.com, in your colours." },
    { icon: LockIcon, title: "Private docs", text: "Single sign-on and reader groups." },
    { icon: SearchIcon, title: "Made for search", text: "SEO settings on every article." },
    { icon: ChartColumnIcon, title: "Search insights", text: "See what customers can't find." },
    { icon: HistoryIcon, title: "Version history", text: "Restore an earlier version." },
    { icon: ArrowRightLeftIcon, title: "Redirects", text: "Old links keep working." },
  ];
  return (
    <section id="features" aria-labelledby="help-center" className="scroll-mt-4 border-y bg-muted/40">
      <div className={cn(WRAP, "py-20 lg:py-28")}>
        <div className="mx-auto max-w-3xl text-center">
          <Eyebrow green>Help center</Eyebrow>
          <h2 id="help-center" className="mt-3 text-4xl font-extrabold tracking-tight text-balance sm:text-5xl">
            Everything customers need to help themselves.
          </h2>
        </div>
        <div className="mt-12 grid items-center gap-10 lg:grid-cols-[1.15fr_1fr]">
          <PortalPicture />
          <ul className="grid grid-cols-2 gap-x-5 gap-y-6">
            {features.map(({ icon: Icon, title, text }) => (
              <li key={title} className="flex flex-col gap-2">
                <span className="flex size-10 items-center justify-center rounded-xl bg-soft text-soft-foreground">
                  <Icon aria-hidden className="size-5" />
                </span>
                <p className="font-semibold">{title}</p>
                <p className="-mt-1.5 text-sm text-muted-foreground">{text}</p>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </section>
  );
}

/** A customer's view of a help center on Tuti, answering a question from its articles. */
function PortalPicture() {
  return (
    <figure aria-label="Acme's help center on help.acme.com, answering “How do I export my data?” from its article, with the source" className="relative">
      <Frame>
        <div aria-hidden className="flex items-center gap-2 border-b bg-muted/50 px-4 py-2.5">
          <span className="flex gap-1.5">
            <span className="size-2.5 rounded-full bg-border" />
            <span className="size-2.5 rounded-full bg-border" />
            <span className="size-2.5 rounded-full bg-border" />
          </span>
          <span className="mx-auto rounded-md bg-background px-3 py-0.5 text-xs text-muted-foreground">help.acme.com</span>
        </div>
        <div aria-hidden className="bg-primary px-6 pt-8 pb-16 text-primary-foreground">
          <p className="flex items-center gap-2 text-sm font-bold">
            <span className="flex size-6 items-center justify-center rounded-md bg-primary-foreground text-xs text-primary">A</span>
            Acme Help
          </p>
          <p className="mt-5 font-heading text-3xl font-bold">How can we help?</p>
        </div>
        <div aria-hidden className="relative -mt-10 px-5 pb-6">
          <div className="rounded-xl border bg-background p-4 shadow-xl">
            <p className="flex items-center gap-2 border-b pb-3 text-sm">
              <SparklesIcon className="size-4 text-primary" /> How do I export my data?
            </p>
            <p className="pt-3 text-sm">
              Open <strong>Settings → Data</strong> and click <strong>Export CSV</strong>. Large workspaces get a download link by email.
            </p>
            <p className="mt-3 flex flex-wrap gap-2 text-xs">
              <span className="flex items-center gap-1 rounded-md border px-2 py-1 font-semibold">
                <BookOpenIcon className="size-3.5" /> Exporting data
              </span>
              <span className="flex items-center gap-1 rounded-md bg-soft px-2 py-1 font-semibold text-soft-foreground">
                <SparklesIcon className="size-3" /> Updated today
              </span>
            </p>
          </div>
          <div className="mt-4 grid grid-cols-3 gap-3">
            {["Getting started", "Billing", "Integrations"].map((name) => (
              <p key={name} className="rounded-lg border bg-background px-3 py-3 text-sm font-semibold">
                {name}
              </p>
            ))}
          </div>
        </div>
      </Frame>
    </figure>
  );
}

/** Feedback, roadmap and changelog: the same shipped feature request, everywhere at once. */
export function Connected() {
  return (
    <section aria-labelledby="connected" className={cn(WRAP, "py-20 lg:py-28")}>
      <div className="mx-auto max-w-3xl text-center">
        <Eyebrow green>Built in</Eyebrow>
        <h2 id="connected" className="mt-3 text-4xl font-extrabold tracking-tight text-balance sm:text-5xl">
          Feedback, roadmap and changelog. In step.
        </h2>
        <p className="mt-4 text-lg text-muted-foreground">Ship a feature request, and all three catch up.</p>
      </div>
      <div aria-hidden className="mt-12 grid items-stretch gap-4 md:grid-cols-3">
        <Panel label="Feedback">
          <p className="flex items-center gap-3 rounded-lg border bg-background px-3 py-2.5">
            <span className="flex w-10 flex-col items-center rounded-md bg-primary py-0.5 text-sm leading-tight font-bold text-primary-foreground">
              128<span className="text-[9px] font-medium opacity-70">votes</span>
            </span>
            <span className="font-semibold">Dark mode</span>
          </p>
          <p className="flex items-center gap-3 rounded-lg border bg-background px-3 py-2.5 opacity-60">
            <span className="flex w-10 flex-col items-center rounded-md border py-0.5 text-sm leading-tight font-bold">
              64<span className="text-[9px] font-medium opacity-70">votes</span>
            </span>
            <span className="font-semibold">Export to CSV</span>
          </p>
        </Panel>
        <Panel label="Roadmap">
          <div className="grid grid-cols-3 gap-2 text-xs">
            {[
              ["Planned", ""],
              ["In progress", ""],
              ["Shipped", "Dark mode"],
            ].map(([column, card]) => (
              <div key={column} className="flex flex-col gap-1.5">
                <p className="font-semibold text-muted-foreground">{column}</p>
                <span className={cn("h-9 rounded-md border", card ? "flex items-center bg-soft px-2 font-semibold text-soft-foreground" : "border-dashed")}>{card}</span>
              </div>
            ))}
          </div>
        </Panel>
        <Panel label="Changelog">
          <p className="text-xs font-semibold text-soft-foreground">New · Today</p>
          <p className="font-heading text-lg font-bold">Dark mode is here</p>
          <p className="text-sm text-muted-foreground">Switch to dark under Settings → Theme.</p>
        </Panel>
      </div>
    </section>
  );
}

function Panel({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-3 rounded-2xl border bg-card p-5 shadow-sm">
      <p className="flex items-center gap-2 text-xs font-bold tracking-wider text-soft-foreground uppercase">
        <Tick className="size-4" /> {label}
      </p>
      {children}
    </div>
  );
}

/** The questions a buyer asks before switching, the how among them. */
export function Faq() {
  const items: [string, string][] = [
    [
      "How does Tuti know what changed?",
      "Connect GitHub, and Tuti reads each change you ship. It checks it against your articles and feature requests, and works out what's now wrong or done.",
    ],
    [
      "Will it publish without me?",
      "Only what it's sure of, and only after a review window (24 hours by default) where you can stop it. Anything else waits for your approval, and most updates can be undone in a click.",
    ],
    [
      "Can I bring my existing help center?",
      "Yes. Move your articles in through the API, or have Claude or Cursor do it over MCP. Redirect your old addresses, so links and rankings keep working.",
    ],
    [
      "Can I use my own domain?",
      `Yes: help.yourcompany.com, or a path of your site like yourcompany.com/help.${plansEnabled() ? " Your own domain comes with Pro, a path of your site with Business." : ""}`,
    ],
    ...(plansEnabled()
      ? ([
          [
            "How much does it cost?",
            `Free to start, Autopilot included: its AI runs on credits, and Free comes with some. ${PLAN_PRICES.PRO.name} adds your own domain and credits every month, at $${PLAN_PRICES.PRO.month} a month per project. Never per seat.`,
          ],
        ] as [string, string][])
      : []),
  ];
  return (
    <section aria-labelledby="faq" className="border-t bg-muted/40">
      <div className={cn(WRAP, "grid gap-10 py-20 lg:grid-cols-[1fr_1.6fr] lg:py-24")}>
        <h2 id="faq" className="text-4xl font-extrabold tracking-tight text-balance">
          Questions before you switch
        </h2>
        <div className="flex flex-col">
          {items.map(([question, answer]) => (
            <details key={question} className="group border-b py-5 first:pt-0">
              <summary className="flex cursor-pointer list-none items-center justify-between gap-4 text-lg font-semibold [&::-webkit-details-marker]:hidden">
                {question}
                <span aria-hidden className="text-2xl leading-none text-muted-foreground transition-transform group-open:rotate-45">
                  +
                </span>
              </summary>
              <p className="mt-3 text-muted-foreground">{answer}</p>
            </details>
          ))}
        </div>
      </div>
    </section>
  );
}

/** The last call. */
export function FinalCta({ title, start, docs }: { title: ReactNode; start: string; docs: string }) {
  return (
    <section className="landing-dots relative overflow-hidden text-center">
      <div aria-hidden className="landing-glow-center pointer-events-none absolute inset-0" />
      <div className={cn(WRAP, "relative py-24 lg:py-32")}>
        <h2 className="mx-auto max-w-3xl text-4xl font-extrabold tracking-tight text-balance sm:text-6xl">{title}</h2>
        <Ctas start={start} docs={docs} className="mt-8" />
      </div>
    </section>
  );
}

export function SlimFooter({ docs }: { docs: string }) {
  return (
    <footer className="border-t">
      <div className={cn(WRAP, "flex flex-wrap items-center justify-between gap-4 py-7 text-sm text-muted-foreground")}>
        <span className="flex items-center gap-2">
          <TutiMark className="size-5" /> Tuti
        </span>
        <nav aria-label="Footer" className="flex gap-4">
          {plansEnabled() && (
            <Link href="/pricing" className="hover:text-foreground">
              Pricing
            </Link>
          )}
          <a href={docs} className="hover:text-foreground">
            Docs
          </a>
          <a href={REPO_URL} className="flex items-center gap-1.5 hover:text-foreground">
            <GithubMark className="size-3.5" /> GitHub
          </a>
        </nav>
      </div>
    </footer>
  );
}
