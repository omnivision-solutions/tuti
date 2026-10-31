import { creditsEnabled, freeCredits, planCredits, plansEnabled } from "@tuti/shared";
import {
  ArrowRightLeftIcon,
  ChartColumnIcon,
  CheckIcon,
  GitMergeIcon,
  GlobeIcon,
  LockIcon,
  MessageCircleIcon,
  PaletteIcon,
  SearchIcon,
  SparklesIcon,
} from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";

import { GithubMark } from "@/components/github-mark";
import { PostStatusBadge } from "@/components/post-status-badge";
import { buttonVariants } from "@/components/ui/button";
import { PLAN_PRICES } from "@/lib/plans";
import { cn } from "@/lib/utils";

import { AutopilotChange, Band, Cell, Checks, Em, Eyebrow, HeroDemo, Intro, WRAP } from "./landing-parts";
import { REPO_URL } from "./links";

/**
 * The help-center-first landing pages' sections (land-a, and the short land-b): the help center
 * shown first, Autopilot told with one article, feedback as the second story.
 */

const big = "h-11 px-5 text-base";

/** Where the call to action goes: the app when signed in, else sign-up. */
export type Start = { href: string; label: string };

export function HelpHero({
  eyebrow,
  title,
  lead,
  start,
  docs,
  autopilotPlan,
  familiar = false,
}: {
  eyebrow: string;
  title: ReactNode;
  lead: ReactNode;
  start: Start;
  docs: string;
  autopilotPlan: string | null;
  familiar?: boolean;
}) {
  const lines = ["“The button moved in March. The article didn't.”", "“Our AI keeps sending people to the old page.”", "“Half our tickets are answered in the docs. Wrongly.”"];
  return (
    <section className="landing-dots relative overflow-hidden">
      <div aria-hidden className="landing-glow pointer-events-none absolute inset-x-0 top-1/4 bottom-0" />
      <div className={cn(WRAP, "relative grid items-center gap-12 py-14 lg:grid-cols-[1.15fr_1fr] lg:py-20")}>
        <div>
          <Eyebrow>{eyebrow}</Eyebrow>
          <h1 className="mt-4 text-4xl font-extrabold tracking-tight text-balance sm:text-5xl lg:text-6xl">{title}</h1>
          <p className="mt-5 text-lg text-muted-foreground text-pretty">{lead}</p>
          <div className="mt-7 flex flex-wrap gap-3">
            <Link href={start.href} className={buttonVariants({ size: "lg", className: big })}>
              {start.label}
            </Link>
            <a href={docs} className={buttonVariants({ size: "lg", variant: "outline", className: big })}>
              See a live help center
            </a>
          </div>
          <Checks
            items={autopilotPlan ? ["Free help center", `Autopilot from ${autopilotPlan}`, "Open source"] : ["Free to start", "Connect GitHub in a minute", "Open source"]}
            className="mt-5"
          />
          {familiar && (
            <p className="mt-8 flex flex-wrap items-baseline gap-x-2 gap-y-1 border-t border-dashed pt-5 text-muted-foreground">
              Sound familiar?
              <span className="relative h-6 min-w-0 basis-full sm:flex-1 sm:basis-auto">
                {lines.map((line, i) => (
                  <span
                    key={line}
                    className="landing-rotate absolute inset-x-0 top-0 truncate font-semibold text-foreground"
                    style={{ animationDelay: `${i * 4}s` }}
                    // Screen readers get the first line, still, from the sr-only copy below (after these, so the first line stays :first-child).
                    aria-hidden
                  >
                    {line}
                  </span>
                ))}
                <span className="sr-only">{lines[0]}</span>
              </span>
            </p>
          )}
        </div>
        <HeroDemo />
      </div>
    </section>
  );
}

/** What a stale article costs: three places it shows. */
export function StaleDocs() {
  const places: { where: string; age: string; picture: ReactNode; cost: string; consequence: string }[] = [
    {
      where: "Help center",
      age: "5 months old",
      picture: (
        <>
          <p className="font-semibold">Exporting data</p>
          <p className="mt-1 text-xs text-muted-foreground">Open Settings → Billing and click Export…</p>
        </>
      ),
      cost: "The button moved in March.",
      consequence: "Customers follow the steps and get lost.",
    },
    {
      where: "AI support",
      age: "confidently wrong",
      picture: (
        <>
          <p>“Go to Settings → Billing → Export.”</p>
          <p className="mt-1 text-xs text-muted-foreground">Source: Exporting data</p>
        </>
      ),
      cost: "Your AI repeats the stale article.",
      consequence: "Now it's wrong at scale, and it sounds sure.",
    },
    {
      where: "Support inbox",
      age: "3 today",
      picture: (
        <>
          <p>“The export button isn&apos;t where your guide says.”</p>
          <p className="mt-1 text-xs text-muted-foreground">Needs reply · 2h</p>
        </>
      ),
      cost: "Every stale step becomes a ticket.",
      consequence: "Your team answers what the docs should have.",
    },
  ];
  return (
    <Band>
      <div className={cn(WRAP, "py-20 lg:py-24")}>
        <Intro problem eyebrow="The problem" title={<>You ship every week. Your help center <Em>stays behind</Em>.</>}>
          Nobody decided to let it rot. Rereading every article after every release just isn&apos;t anyone&apos;s job.
        </Intro>
        <ul className="mt-12 grid gap-4 md:grid-cols-3">
          {places.map((item) => (
            <li key={item.where} className="flex flex-col gap-3 rounded-xl border bg-card p-5 shadow-sm">
              <p className="text-xs font-bold tracking-wider text-muted-foreground uppercase">{item.where}</p>
              <div className="relative rounded-lg border bg-background p-3 text-sm opacity-80 sepia-[.25]">
                <span className="absolute -top-2.5 right-2.5 rounded-full border border-highlight-foreground/25 bg-highlight px-2 py-0.5 text-[11px] font-bold text-highlight-foreground">
                  {item.age}
                </span>
                {item.picture}
              </div>
              <p className="font-semibold">{item.cost}</p>
              <p className="-mt-2 text-sm text-muted-foreground">{item.consequence}</p>
            </li>
          ))}
        </ul>
      </div>
    </Band>
  );
}

/** The help center itself: what customers see, and what a buyer checks for. */
export function HelpCenterShowcase({ docs }: { docs: string }) {
  const basics: { icon: typeof GlobeIcon; title: string; text: string }[] = [
    { icon: GlobeIcon, title: "Your own domain", text: "help.acme.com, or under a path of your site: acme.com/help." },
    { icon: PaletteIcon, title: "Your brand", text: "Colours, logos and fonts, and your own CSS and HTML." },
    { icon: LockIcon, title: "Private docs", text: "Sign readers in with your single sign-on, and choose who reads each page." },
    { icon: SearchIcon, title: "Found in search", text: "Titles, descriptions and indexing set per article." },
    { icon: ArrowRightLeftIcon, title: "Old links keep working", text: "Redirect your old help center's addresses to the new articles." },
    { icon: MessageCircleIcon, title: "Inside your product", text: "A widget with help, what's new and messages, behind one button." },
    { icon: SparklesIcon, title: "AI answers with sources", text: "Only from your articles, each answer linked to where it came from." },
    { icon: ChartColumnIcon, title: "What readers can't find", text: "Searches that found nothing, and articles marked unhelpful." },
  ];
  return (
    <section id="features" aria-labelledby="help-center" className={cn(WRAP, "scroll-mt-4 py-20 lg:py-24")}>
      <Intro id="help-center" eyebrow="The help center" title="A help center your customers can find their way around.">
        Everything you&apos;d expect, on your domain and in your brand.{" "}
        <a href={docs} className="font-semibold text-primary underline-offset-4 hover:underline">
          Tuti&apos;s own help center runs on Tuti →
        </a>
      </Intro>
      <div className="mt-12 grid items-start gap-10 lg:grid-cols-[1.1fr_1fr]">
        <PortalMock />
        <ul className="grid gap-x-6 gap-y-5 sm:grid-cols-2">
          {basics.map(({ icon: Icon, title, text }) => (
            <li key={title} className="flex gap-3">
              <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-soft text-soft-foreground">
                <Icon aria-hidden className="size-4.5" />
              </span>
              <div>
                <p className="font-semibold">{title}</p>
                <p className="text-sm text-muted-foreground">{text}</p>
              </div>
            </li>
          ))}
        </ul>
      </div>
      {plansEnabled() && (
        <p className="mt-8 text-sm text-muted-foreground">
          Your own domain from Pro; private docs and a path of your site on Business.{" "}
          <Link href="/pricing" className="font-semibold text-foreground underline-offset-4 hover:underline">
            See what each plan includes
          </Link>
        </p>
      )}
    </section>
  );
}

/** A customer's view of a help center on Tuti: search, ask, collections. */
function PortalMock() {
  const collections: { name: string; count: string; fresh?: boolean }[] = [
    { name: "Getting started", count: "8 articles" },
    { name: "Exporting data", count: "Updated today", fresh: true },
    { name: "Billing and plans", count: "5 articles" },
    { name: "Integrations", count: "12 articles" },
  ];
  return (
    <figure aria-label="Acme's help center on help.acme.com: a search box, Ask AI, and four collections" className="overflow-hidden rounded-xl border bg-card shadow-lg">
      <div aria-hidden className="flex items-center gap-2 border-b bg-muted/50 px-4 py-2.5">
        <span className="flex gap-1.5">
          <span className="size-2.5 rounded-full bg-border" />
          <span className="size-2.5 rounded-full bg-border" />
          <span className="size-2.5 rounded-full bg-border" />
        </span>
        <span className="mx-auto rounded-md bg-background px-3 py-0.5 text-xs text-muted-foreground">help.acme.com</span>
      </div>
      <div aria-hidden>
        <div className="bg-primary px-6 py-8 text-primary-foreground">
          <p className="flex items-center gap-2 font-bold">
            <span className="flex size-6 items-center justify-center rounded-md bg-primary-foreground text-xs text-primary">A</span>
            Acme Help
          </p>
          <p className="mt-4 font-heading text-2xl font-bold">How can we help?</p>
          <div className="mt-3 flex gap-2">
            <p className="flex flex-1 items-center gap-2 rounded-lg bg-background px-3 py-2 text-sm text-muted-foreground">
              <SearchIcon className="size-4" /> Search, or ask a question
            </p>
            <span className="flex items-center gap-1.5 rounded-lg bg-primary-foreground/15 px-3 text-sm font-semibold">
              <SparklesIcon className="size-4" /> Ask AI
            </span>
          </div>
        </div>
        <ul className="grid grid-cols-2 gap-3 p-5">
          {collections.map((c) => (
            <li key={c.name} className="rounded-lg border bg-background p-3.5">
              <p className="text-sm font-semibold">{c.name}</p>
              <p className={cn("mt-1 text-xs", c.fresh ? "font-semibold text-soft-foreground" : "text-muted-foreground")}>{c.count}</p>
            </li>
          ))}
        </ul>
      </div>
    </figure>
  );
}

/** Autopilot, told with one article: the pull request's change, the article's rewrite, three steps. */
export function RewriteExample() {
  const steps: [string, string][] = [
    ["You merge a pull request", "Tuti reads every pull request merged on the GitHub repositories you connect."],
    ["It finds the articles now wrong", "It compares what changed with your published articles, and rewrites only the sections that no longer match."],
    ["It goes out, or waits for you", "Rewrites it's sure of go out after a hold you can stop. The rest wait for a click."],
  ];
  return (
    <section id="how-it-works" aria-labelledby="rewrite" className="dark landing-dots scroll-mt-4 border-y bg-background text-foreground">
      <div className={cn(WRAP, "py-20 lg:py-24")}>
        <Intro id="rewrite" center eyebrow="How Autopilot works" title="One merge. The articles it made wrong, rewritten.">
          Here&apos;s a real kind of change: the export button moved, and the article still points at the old place.
        </Intro>
        <div className="mt-12 grid items-stretch gap-4 lg:grid-cols-[1fr_auto_1fr]">
          <figure aria-label="Pull request 512 moves Export from the Billing settings to the Data settings" className="min-w-0 rounded-xl border bg-card p-5">
            <p className="flex items-center gap-2 text-sm font-bold">
              <GitMergeIcon aria-hidden className="size-4 text-primary" /> #512 Move export to Settings → Data
            </p>
            <p className="mt-1 text-xs text-muted-foreground">acme/app · settings/sections.ts</p>
            <pre aria-hidden className="mt-4 overflow-x-auto rounded-lg bg-background p-3 font-mono text-[13px] leading-relaxed">
              <span className="block bg-destructive/15 px-2 text-destructive">- billing: [&quot;plan&quot;, &quot;invoices&quot;, &quot;export&quot;],</span>
              <span className="block bg-soft px-2 text-soft-foreground">+ billing: [&quot;plan&quot;, &quot;invoices&quot;],</span>
              <span className="block bg-soft px-2 text-soft-foreground">+ data: [&quot;export&quot;, &quot;import&quot;],</span>
            </pre>
          </figure>
          <span aria-hidden className="flex items-center justify-center text-primary max-lg:rotate-90">
            <span className="text-2xl">→</span>
          </span>
          <figure
            aria-label="The article Exporting data: Open Settings → Billing becomes Open Settings → Data; the rest stays as written"
            className="min-w-0 rounded-xl border border-primary/60 bg-card p-5 shadow-[0_0_60px_-20px_var(--primary)]"
          >
            <p className="flex justify-between text-sm font-bold">
              Exporting data <span className="text-xs font-normal text-soft-foreground">rewritten by Autopilot</span>
            </p>
            <div aria-hidden className="mt-4 flex flex-col gap-1.5 text-sm">
              <p className="px-2">Download everything in your workspace as a CSV.</p>
              <del className="block rounded-md bg-destructive/15 px-2 text-destructive">Open Settings → Billing and click Export CSV.</del>
              <ins className="block rounded-md bg-soft px-2 text-soft-foreground no-underline">Open Settings → Data and click Export CSV.</ins>
              <p className="px-2 text-muted-foreground">Large workspaces get an email with a link when the file is ready.</p>
            </div>
            <p className="mt-4 text-xs text-muted-foreground">The sections the code didn&apos;t touch stay word for word.</p>
          </figure>
        </div>
        <ol className="mt-10 grid gap-6 md:grid-cols-3">
          {steps.map(([title, text], i) => (
            <li key={title} className="flex gap-4">
              <span className="flex size-9 shrink-0 items-center justify-center rounded-full border-2 border-primary bg-soft font-bold text-soft-foreground">{i + 1}</span>
              <div>
                <p className="font-semibold">{title}</p>
                <p className="text-sm text-muted-foreground">{text}</p>
              </div>
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}

/** What goes out by itself and what waits, in Autopilot's defaults. */
export function Supervised() {
  const points: [string, string][] = [
    ["Sure of it? It goes out after a hold.", "Rewrites it's at least 95% sure of go out after 24 hours. You get an email with Publish now and Stop."],
    ["Not sure, or a popular article? It asks.", "Anything less sure, and any article read 500 times in a month, waits for your click."],
    ["Changed your mind? Undo it.", "Autopilot's page lists what went out and what's next, and most updates can be undone."],
  ];
  return (
    <Band>
      <div className={cn(WRAP, "grid items-center gap-12 py-20 lg:grid-cols-[1fr_1.1fr] lg:py-24")}>
        <div>
          <Intro eyebrow="On autopilot, not unsupervised" title={<>Your docs, rewritten. <Em>Never behind your back.</Em></>} />
          <ol className="mt-8 flex flex-col gap-5">
            {points.map(([title, text], i) => (
              <li key={title} className="flex gap-4">
                <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-soft font-bold text-soft-foreground">{i + 1}</span>
                <div>
                  <p className="font-semibold">{title}</p>
                  <p className="text-muted-foreground">{text}</p>
                </div>
              </li>
            ))}
          </ol>
          <p className="mt-6 text-sm text-muted-foreground">The hold, the thresholds and what goes out by itself are yours to change, down to a click for everything.</p>
        </div>
        <AutopilotChange />
      </div>
    </Band>
  );
}

/** The second story: the same merge closes feature requests and drafts the changelog. */
export function AlsoFeedback() {
  const cards: { kind: string; title: ReactNode; note: string }[] = [
    { kind: "Feedback", title: <span className="flex items-center gap-2">Dark mode <PostStatusBadge status="COMPLETED" /></span>, note: "All 128 voters told, after your click" },
    { kind: "Roadmap", title: <span className="flex items-center gap-2">Dark mode on mobile <PostStatusBadge status="IN_PROGRESS" /></span>, note: "With a progress update, after the hold" },
    { kind: "Changelog", title: "Dark mode is here", note: "Drafted in your voice, in the next entry" },
  ];
  return (
    <section aria-labelledby="also" className={cn(WRAP, "py-20 lg:py-24")}>
      <Intro id="also" eyebrow="The same merge, one more thing" title="Feature requests close themselves too.">
        Tuti has a feedback board, roadmap and changelog built in. When a merge ships what people asked for, it lines up the request to complete, tells everyone who voted, and writes the changelog line.
      </Intro>
      <ul className="mt-10 grid gap-4 md:grid-cols-3">
        {cards.map((card) => (
          <li key={card.kind} className="flex min-w-0 flex-col gap-1.5 rounded-xl border bg-card px-5 py-4">
            <p className="text-xs font-bold tracking-wider text-soft-foreground uppercase">{card.kind}</p>
            <div className="font-semibold">{card.title}</div>
            <p className="text-sm text-muted-foreground">{card.note}</p>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** Coming from another help center: getting the articles in, keeping old links, leaving again. */
export function Switching() {
  const points: [string, string][] = [
    ["Bring your articles", "Through the API, or have Claude or Cursor copy them over with Tuti's MCP server."],
    ["Keep your old links", "Redirect the old help center's addresses, so links and search rankings keep working."],
    ["Leave whenever you like", "Export everything at any time, or run Tuti on your own servers."],
  ];
  return (
    <Band>
      <div className={cn(WRAP, "py-20 lg:py-24")}>
        <Intro center eyebrow="Switching" title="Moving from Intercom, Zendesk or GitBook?" />
        <ul className="mt-10 grid gap-4 md:grid-cols-3">
          {points.map(([title, text]) => (
            <li key={title} className="min-w-0 rounded-xl border bg-card p-5">
              <p className="flex items-center gap-2 font-semibold">
                <CheckIcon aria-hidden className="size-4 text-primary" strokeWidth={3} /> {title}
              </p>
              <p className="mt-1 text-sm text-muted-foreground">{text}</p>
            </li>
          ))}
        </ul>
      </div>
    </Band>
  );
}

/** Why Tuti exists, in the makers' words. */
export function WhyWeBuilt() {
  return (
    <section aria-labelledby="why" className={cn(WRAP, "py-20 lg:py-24")}>
      <figure className="mx-auto max-w-3xl text-center">
        <Eyebrow green>Why we built it</Eyebrow>
        <blockquote id="why" className="mt-5 font-heading text-2xl font-bold tracking-tight text-balance sm:text-3xl">
          “Our AI support kept sending customers to buttons that had moved. The docs were a release behind, and requests we&apos;d shipped months ago still said Planned. Nobody had
          dropped the ball. Keeping it all true after every merge just wasn&apos;t anyone&apos;s job. So we made it the merge&apos;s job.”
        </blockquote>
        <figcaption className="mt-5 text-muted-foreground">The team behind Tuti</figcaption>
      </figure>
    </section>
  );
}

/** Tuti beside the help desks people compare it with. Only what their public sites say. */
export function CompareSuites() {
  const rows: { row: string; intercom: ReactNode; zendesk: ReactNode; tuti: string }[] = [
    { row: "Help center with AI answers", intercom: true, zendesk: true, tuti: "" },
    { row: "Articles rewritten when your code changes", intercom: false, zendesk: false, tuti: "on merge" },
    { row: "Feature requests closed as you ship", intercom: false, zendesk: false, tuti: "from merged PRs" },
    { row: "Open source, self-hostable", intercom: false, zendesk: false, tuti: "AGPL" },
    { row: "Priced", intercom: "per seat", zendesk: "per agent", tuti: "per project" },
  ];
  return (
    <section aria-labelledby="compare" className={cn(WRAP, "py-20 lg:py-24")}>
      <Intro id="compare" center eyebrow="Why Tuti" title={<>Others host your docs. <Em>Tuti keeps them true.</Em></>} />
      <table className="mt-12 w-full border-separate border-spacing-0 text-sm sm:text-base">
        <thead>
          <tr className="text-sm text-muted-foreground">
            <th className="border-b p-3 text-left font-medium sm:px-5" />
            <th className="w-1/5 border-b p-3 font-medium">Intercom</th>
            <th className="w-1/5 border-b p-3 font-medium">Zendesk</th>
            <th className="w-1/5 rounded-t-xl border-b bg-soft p-3 text-base font-bold text-soft-foreground">Tuti</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={row.row}>
              <td className="border-b p-3 sm:px-5">{row.row}</td>
              <td className="border-b p-3 text-center">
                <Cell value={row.intercom} />
              </td>
              <td className="border-b p-3 text-center">
                <Cell value={row.zendesk} />
              </td>
              <td className={cn("border-b bg-soft p-3 text-center font-semibold text-soft-foreground", i === rows.length - 1 && "rounded-b-xl border-b-0")}>
                <span className="inline-flex items-center gap-1.5">
                  {row.row !== "Priced" && <CheckIcon aria-label="Yes" className="size-4" strokeWidth={3} />}
                  {row.tuti}
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="mt-4 text-center text-xs text-muted-foreground">From Intercom&apos;s and Zendesk&apos;s public sites, October 2026.</p>
    </section>
  );
}

/** Prices in brief, on servers that sell plans. */
export function PricingTeaser() {
  if (!plansEnabled()) return null;
  const pro = PLAN_PRICES.PRO;
  // AI answers run on credits where they're sold: Free gets a grant to start, Pro some each month (as /pricing says).
  const startCredits = creditsEnabled() && freeCredits() > 0 ? `, with ${freeCredits().toLocaleString("en")} AI credits to start` : "";
  const proCredits = creditsEnabled() ? `, ${planCredits("PRO").toLocaleString("en")} AI credits a month` : "";
  const tiers: { name: string; price: string; text: string }[] = [
    { name: "Free", price: "$0", text: `Help center, feedback board, roadmap and changelog${startCredits}.` },
    { name: pro.name, price: `$${pro.month} a month`, text: `Autopilot, your own domain${proCredits} and unlimited team members. Per project, not per seat.` },
    { name: "Self-hosted", price: "Free", text: "Every feature on your own servers, open source under AGPL-3.0." },
  ];
  return (
    <Band>
      <div className={cn(WRAP, "py-20 lg:py-24")}>
        <Intro center eyebrow="Pricing" title="Priced per project. Readers are always unlimited." />
        <ul className="mt-10 grid gap-4 md:grid-cols-3">
          {tiers.map((tier) => (
            <li key={tier.name} className={cn("rounded-xl border bg-card p-6", tier.name === pro.name && "border-primary/60 shadow-[0_0_50px_-20px_var(--primary)]")}>
              <p className="font-semibold">{tier.name}</p>
              <p className="mt-1 font-heading text-3xl font-extrabold tracking-tight">{tier.price}</p>
              <p className="mt-2 text-sm text-muted-foreground">{tier.text}</p>
            </li>
          ))}
        </ul>
        <p className="mt-6 text-center">
          <Link href="/pricing" className="font-semibold text-primary underline-offset-4 hover:underline">
            See every plan →
          </Link>
        </p>
      </div>
    </Band>
  );
}

/** The closing call, with open source in one line. */
export function HelpLastCall({ start, autopilotPlan }: { start: Start; autopilotPlan: string | null }) {
  return (
    <section className="landing-dots relative overflow-hidden text-center">
      <div aria-hidden className="landing-glow-center pointer-events-none absolute inset-0" />
      <div className={cn(WRAP, "relative py-24 lg:py-28")}>
        <Eyebrow>Right now, somewhere</Eyebrow>
        <h2 className="mx-auto mt-4 max-w-3xl text-4xl font-extrabold tracking-tight text-balance sm:text-5xl">
          Your AI is telling a customer to click a button <Em>that moved.</Em>
        </h2>
        <p className="mt-5 text-lg text-muted-foreground">
          {autopilotPlan ? `Start with a free help center. Connect GitHub on ${autopilotPlan}, and your next merge fixes it.` : "Connect GitHub, and your next merge fixes it."}
        </p>
        <div className="mt-7 flex flex-wrap justify-center gap-3">
          <Link href={start.href} className={buttonVariants({ size: "lg", className: big })}>
            {start.label}
          </Link>
          <a href={REPO_URL} className={buttonVariants({ size: "lg", variant: "outline", className: big })}>
            <GithubMark className="size-4" /> Open source on GitHub
          </a>
        </div>
        <p className="mt-6 text-sm text-muted-foreground">AGPL-3.0. Host it yourself for free, with every feature.</p>
      </div>
    </section>
  );
}
