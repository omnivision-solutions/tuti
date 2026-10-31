import { plansEnabled } from "@tuti/shared";
import { CheckIcon, GitMergeIcon, MinusIcon, SearchIcon } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import type { CSSProperties, ReactNode } from "react";

import { GithubMark } from "@/components/github-mark";
import { PostStatusBadge } from "@/components/post-status-badge";
import { TutiMark } from "@/components/tuti-logo";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { getSession } from "@/server/session";

import "./landing.css";
import { docsUrl, REPO_URL } from "./links";

export const metadata: Metadata = {
  title: "Tuti: your docs and roadmap, kept true every time you ship",
  description:
    "When a pull request merges, Tuti updates the docs it changes, closes the requests it ships and tells the people who asked, so your AI never answers from stale docs. Feedback, roadmap, changelog and help center. Open source.",
};

/** A section's content column. */
const WRAP = "mx-auto w-full max-w-6xl px-6";

/** The four places that go stale while you ship, and what each one costs. */
const STALE: { where: string; age: string; picture: ReactNode; cost: string; consequence: string }[] = [
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
    consequence: "Customers follow the steps, get lost, and open a ticket.",
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
    where: "Feedback board",
    age: "since March",
    picture: (
      <>
        <p>
          <span className="font-semibold">Dark mode</span> · 128 votes
        </p>
        <div className="mt-2">
          <PostStatusBadge status="PLANNED" />
        </div>
      </>
    ),
    cost: "It shipped months ago.",
    consequence: "128 people think you're still ignoring them.",
  },
  {
    where: "Changelog",
    age: "3 releases behind",
    picture: (
      <>
        <p className="font-semibold">Faster search</p>
        <p className="mt-1 text-xs text-muted-foreground">Latest entry · June 4</p>
      </>
    ),
    cost: "Your best work goes unannounced.",
    consequence: "Users never find out what you built for them.",
  },
];

/** After a release: the list nobody gets to, and what Tuti does instead (with when). */
const CHORES: { todo: string; when: string; done: string; how: string }[] = [
  { todo: "Move “Dark mode” to Completed", when: "someday", done: "“Dark mode” moved to Completed", how: "on release" },
  { todo: "Rewrite “Changing your theme”", when: "next sprint", done: "“Changing your theme” rewritten", how: "after a hold" },
  { todo: "Write the changelog entry", when: "Friday?", done: "Changelog line drafted in your voice", how: "on merge" },
  { todo: "Email the 128 people who voted", when: "forgot", done: "128 voters told", how: "one click" },
  { todo: "Check what the AI now says", when: "never", done: "AI answers from the new article", how: "as it's published" },
];

/** What one merge updates; `place` puts each card in the fan's grid around the merge. */
const FAN: { kind: string; when: string; title: string; note: string; place: string }[] = [
  { kind: "Feedback", when: "on release", title: "Dark mode → Completed", note: "128 voters told, with one click from you", place: "lg:col-start-1 lg:row-start-1" },
  { kind: "Docs", when: "after a hold", title: "Changing your theme", note: "2 paragraphs rewritten to match the code", place: "lg:col-start-3 lg:row-start-1" },
  { kind: "Changelog", when: "on merge", title: "Dark mode is here", note: "Written in your voice, in the next draft", place: "lg:col-start-1 lg:row-start-2" },
  { kind: "AI answers", when: "as it's published", title: "“Pick Dark under Theme.”", note: "From the updated article", place: "lg:col-start-3 lg:row-start-2" },
];

/** One request's life, and who does each step. */
const STEPS: { who: "Customer" | "You" | "Tuti"; title: string; text: string }[] = [
  { who: "Customer", title: "Posts “Dark mode”", text: "Similar posts show while they type, so votes land on one post." },
  { who: "Tuti", title: "Gathers the votes", text: "128 votes, and who they're from: their company and plan." },
  { who: "You", title: "Open a pull request", text: "Write the code. That's your part." },
  { who: "Tuti", title: "Moves it to In progress", text: "Voters see it's being built without asking." },
  { who: "Tuti", title: "Updates docs and changelog", text: "On merge, from what the code actually changed." },
  { who: "Tuti", title: "Completes it, tells 128 people", text: "When the release goes out." },
];

/** Tuti beside the two kinds of tool it replaces. */
const COMPARE: { row: string; boards: ReactNode; helpCenters: ReactNode; tuti: string }[] = [
  { row: "Feedback, roadmap and changelog", boards: true, helpCenters: false, tuti: "" },
  { row: "Help center with AI answers", boards: "add-on", helpCenters: true, tuti: "" },
  { row: "Statuses move as you build", boards: "by hand", helpCenters: false, tuti: "from your PRs" },
  { row: "Docs updated when the code changes", boards: false, helpCenters: "some", tuti: "on merge" },
  { row: "Voters told when it ships", boards: "by hand", helpCenters: false, tuti: "on release" },
  { row: "Open source, self-hostable", boards: false, helpCenters: false, tuti: "AGPL" },
  { row: "Priced per project, not per seat", boards: "varies", helpCenters: "varies", tuti: "" },
];

export default async function Home() {
  const session = await getSession();
  const start = session ? { href: "/app", label: "Open app" } : { href: "/sign-up", label: "Start free" };
  const docs = await docsUrl();
  const big = "h-11 px-5 text-base";

  return (
    // `data-full`: the marketing layout lets this page's sections run the whole width.
    <div data-full className="flex flex-col">
      {/* 1. The problem */}
      <section className="landing-dots relative overflow-hidden">
        <div aria-hidden className="landing-glow pointer-events-none absolute inset-x-0 top-1/4 bottom-0" />
        <div className={cn(WRAP, "relative grid items-center gap-12 py-14 lg:grid-cols-[1.15fr_1fr] lg:py-20")}>
          <div>
            <Eyebrow>Your product moved on. Your docs didn&apos;t.</Eyebrow>
            <h1 className="mt-4 text-4xl font-extrabold tracking-tight text-balance sm:text-5xl lg:text-6xl">
              Your AI is answering from <span className="text-highlight-foreground">last month&apos;s</span> docs.
            </h1>
            <p className="mt-5 text-lg text-muted-foreground text-pretty">
              Every time you ship, Tuti <strong className="font-semibold text-foreground">updates your docs</strong>,{" "}
              <strong className="font-semibold text-foreground">closes the requests</strong> and{" "}
              <strong className="font-semibold text-foreground">tells the people who asked</strong>. On autopilot.
            </p>
            <div className="mt-7 flex flex-wrap gap-3">
              <Link href={start.href} className={buttonVariants({ size: "lg", className: big })}>
                {start.label}
              </Link>
              <a href="#how-it-works" className={buttonVariants({ size: "lg", variant: "outline", className: big })}>
                See how it works
              </a>
            </div>
            <Checks items={["Free to start", "Connect GitHub in a minute", "Open source"]} className="mt-5" />
            <p className="mt-8 flex flex-wrap items-baseline gap-x-2 gap-y-1 border-t border-dashed pt-5 text-muted-foreground">
              Sound familiar?
              <span className="relative h-6 min-w-0 basis-full sm:flex-1 sm:basis-auto">
                {["“Shipped in March. Still marked Planned.”", "“128 people asked. Nobody told them.”", "“The changelog is three releases behind.”"].map(
                  (line, i) => (
                    <span
                      key={line}
                      className="landing-rotate absolute inset-x-0 top-0 truncate font-semibold text-foreground"
                      style={{ animationDelay: `${i * 4}s` }}
                    >
                      {line}
                    </span>
                  ),
                )}
              </span>
            </p>
          </div>
          <HeroDemo />
        </div>
      </section>

      {/* 2. Agitate: what goes stale */}
      <Band>
        <div className={cn(WRAP, "py-20 lg:py-24")}>
          <Intro problem eyebrow="The problem" title={<>You ship every week. Everything around your product <Em>stays behind</Em>.</>}>
            Nobody decided to let it rot. It&apos;s just that updating four tools after every release is nobody&apos;s job.
          </Intro>
          <ul className="mt-12 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {STALE.map((item) => (
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

      {/* 3. Reactive vs proactive */}
      <section aria-labelledby="chores" className={cn(WRAP, "py-20 lg:py-24")}>
        <Intro id="chores" center eyebrow="Reactive vs proactive" title={<>Other tools wait for you to update them. <Em>Tuti doesn&apos;t.</Em></>} />
        <div className="mt-12 grid gap-6 lg:grid-cols-2">
          <div className="rounded-2xl border bg-card p-7">
            <h3 className="text-xl font-bold">After every release, with other tools</h3>
            <p className="mt-1 text-sm text-muted-foreground">The list you meant to get to.</p>
            <ul className="mt-5 flex flex-col gap-2.5">
              {CHORES.map((chore) => (
                <li key={chore.todo} className="flex items-center gap-3 rounded-lg border border-dashed px-3.5 py-3">
                  <span aria-hidden className="size-4.5 shrink-0 rounded-[5px] border-2" />
                  <span className="min-w-0 flex-1">{chore.todo}</span>
                  <span className="text-xs font-semibold whitespace-nowrap text-highlight-foreground">{chore.when}</span>
                </li>
              ))}
            </ul>
          </div>
          {/* Dark in both themes, so the answer stands out from the problem beside it. */}
          <div className="dark relative overflow-hidden rounded-2xl border bg-background p-7 text-foreground">
            <div aria-hidden className="pointer-events-none absolute inset-x-[20%] -bottom-1/2 h-full rounded-full bg-primary/20 blur-3xl" />
            <h3 className="relative text-xl font-bold">After every release, with Tuti</h3>
            <p className="relative mt-1 text-sm text-muted-foreground">Done before you&apos;ve closed the tab.</p>
            <ul className="relative mt-5 flex flex-col gap-2.5">
              {CHORES.map((chore, i) => (
                <li
                  key={chore.done}
                  className="landing-tick flex items-center gap-3 rounded-lg border bg-card px-3.5 py-3"
                  style={{ animationDelay: `${i * 0.3}s` }}
                >
                  <span aria-hidden className="flex size-4.5 shrink-0 items-center justify-center rounded-[5px] bg-primary text-primary-foreground">
                    <CheckIcon className="size-3.5" strokeWidth={3} />
                  </span>
                  <span className="min-w-0 flex-1">{chore.done}</span>
                  <span className="text-xs font-semibold whitespace-nowrap text-soft-foreground">{chore.how}</span>
                </li>
              ))}
            </ul>
            <p className="relative mt-5 flex items-center rounded-xl bg-soft px-4 py-3.5 font-bold text-soft-foreground">
              Your part:<code className="ml-auto font-mono text-sm">git merge</code>
            </p>
          </div>
        </div>
        <p className="mt-7 text-center text-muted-foreground">
          Now multiply the left column by <strong className="text-foreground">every pull request, every week</strong>.
        </p>
      </section>

      {/* 4. The answer: one merge, everything updated */}
      <section id="how-it-works" aria-labelledby="fan" className="dark landing-dots scroll-mt-4 border-y bg-background text-foreground">
        <div className={cn(WRAP, "py-20 lg:py-24")}>
          <Intro id="fan" center eyebrow="How Autopilot works" title="One merge. Everything that depends on it, updated.">
            Tuti reads each pull request you merge and works out what it changes:{" "}
            <strong className="text-foreground">the requests it ships, the articles now wrong, the line for the changelog</strong>.
          </Intro>
          <MergeFan />
        </div>
      </section>

      {/* 5. Proactive, start to finish */}
      <section aria-labelledby="steps" className={cn(WRAP, "py-20 lg:py-24")}>
        <Intro id="steps" center eyebrow="Proactive, start to finish" title="Follow one request. See who did the work." />
        <ol className="relative mt-12 grid grid-cols-2 gap-x-4 gap-y-10 sm:grid-cols-3 lg:grid-cols-6">
          <span aria-hidden className="absolute inset-x-[8%] top-5 hidden h-0.5 bg-linear-to-r from-border to-primary lg:block" />
          {STEPS.map((step, i) => (
            <li key={step.title} className="relative flex flex-col items-center text-center">
              <span
                className={cn(
                  "flex size-10 items-center justify-center rounded-full border-2 bg-background font-bold",
                  step.who === "Tuti" && "border-primary bg-soft text-soft-foreground",
                  step.who === "You" && "border-foreground bg-foreground text-background",
                )}
              >
                {i + 1}
              </span>
              <Badge variant={step.who === "Tuti" ? "soft" : step.who === "You" ? "default" : "secondary"} className="mt-3">
                {step.who}
              </Badge>
              <p className="mt-2 text-sm font-semibold">{step.title}</p>
              <p className="mt-1 text-sm text-muted-foreground">{step.text}</p>
            </li>
          ))}
        </ol>
        <p className="mt-10 text-center text-lg">
          You write the code. <span className="font-semibold text-primary">Tuti does the rest.</span>
        </p>
      </section>

      {/* 6. Trust: on autopilot, not unsupervised */}
      <Band>
        <div className={cn(WRAP, "grid items-center gap-12 py-20 lg:grid-cols-[1fr_1.1fr] lg:py-24")}>
          <div>
            <Intro eyebrow="On autopilot, not unsupervised" title={<>It goes out by itself. <Em>You can always stop it.</Em></>} />
            <ol className="mt-8 flex flex-col gap-5">
              {[
                ["Sure? It waits out a hold, then goes.", "Article fixes and progress updates wait a day (you pick how long), so there's time to look. Or don't."],
                ["Not sure? It asks you.", "Anything it isn't sure of, or that reaches lots of people, waits for your click."],
                ["One email, one click.", "Approve, Publish now or Stop, straight from your inbox. Every change can be undone."],
              ].map(([title, text], i) => (
                <li key={title} className="flex gap-4">
                  <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-soft font-bold text-soft-foreground">{i + 1}</span>
                  <div>
                    <p className="font-semibold">{title}</p>
                    <p className="text-muted-foreground">{text}</p>
                  </div>
                </li>
              ))}
            </ol>
          </div>
          <AutopilotEmail />
        </div>
      </Band>

      {/* 7. Everything else */}
      <section id="features" aria-labelledby="everything" className={cn(WRAP, "scroll-mt-4 py-20 lg:py-24")}>
        <Intro id="everything" eyebrow="Everything in one place" title="Feedback, roadmap, changelog, help center and inbox.">
          They&apos;re one product, so they know about each other. That&apos;s what lets Autopilot keep them all true.
        </Intro>
        <Bento />
      </section>

      {/* 8. Why Tuti */}
      <Band>
        <div className={cn(WRAP, "py-20 lg:py-24")}>
          <Intro center eyebrow="Why Tuti" title={<>Others hold your feedback and docs. <Em>Tuti keeps them true.</Em></>} />
          {/* On phones, without Help centers, so Tuti's column fits beside the rows. */}
          <div className="mt-12">
            <table className="w-full border-separate border-spacing-0 text-sm sm:text-base">
              <thead>
                <tr className="text-sm text-muted-foreground">
                  <th className="border-b p-3 text-left font-medium sm:px-5" />
                  <th className="w-1/5 border-b p-3 font-medium">Feedback boards</th>
                  <th className="w-1/5 border-b p-3 font-medium max-sm:hidden">Help centers</th>
                  <th className="w-1/5 rounded-t-xl border-b bg-soft p-3 text-base font-bold text-soft-foreground">Tuti</th>
                </tr>
              </thead>
              <tbody>
                {COMPARE.map((row, i) => (
                  <tr key={row.row}>
                    <td className="border-b p-3 sm:px-5">{row.row}</td>
                    <td className="border-b p-3 text-center">
                      <Cell value={row.boards} />
                    </td>
                    <td className="border-b p-3 text-center max-sm:hidden">
                      <Cell value={row.helpCenters} />
                    </td>
                    <td
                      className={cn(
                        "border-b bg-soft p-3 text-center font-semibold text-soft-foreground",
                        i === COMPARE.length - 1 && "rounded-b-xl border-b-0",
                      )}
                    >
                      <span className="inline-flex items-center gap-1.5">
                        <CheckIcon aria-label="Yes" className="size-4" strokeWidth={3} />
                        {row.tuti}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </Band>

      {/* 9. Open source */}
      <section aria-labelledby="oss" className={cn(WRAP, "py-20 lg:py-24")}>
        <div className="grid items-center gap-10 rounded-3xl border bg-card p-7 sm:p-11 lg:grid-cols-2">
          <div>
            <Eyebrow green>Open source</Eyebrow>
            <h2 id="oss" className="mt-3 text-3xl font-extrabold tracking-tight text-balance sm:text-4xl">
              Your servers or ours. Every feature either way.
            </h2>
            <p className="mt-4 text-lg text-muted-foreground">
              AGPL-3.0, Docker images, Postgres and any SMTP provider. Self-hosting is free, with nothing held back.
            </p>
            <a href={REPO_URL} className={buttonVariants({ size: "lg", variant: "outline", className: cn(big, "mt-6") })}>
              <GithubMark className="size-4" /> View on GitHub
            </a>
          </div>
          <Terminal
            lines={[
              ["comment", "# run Tuti on your own server"],
              ["command", "git clone https://github.com/omnivision-solutions/tuti"],
              ["command", "docker compose up -d"],
              ["comment", "web     ready"],
              ["comment", "worker  watching for merged pull requests"],
            ]}
          />
        </div>
      </section>

      {/* 10. Last call */}
      <section className="landing-dots relative overflow-hidden text-center">
        <div aria-hidden className="landing-glow-center pointer-events-none absolute inset-0" />
        <div className={cn(WRAP, "relative py-24 lg:py-28")}>
          <Eyebrow>Right now, somewhere</Eyebrow>
          <h2 className="mx-auto mt-4 max-w-3xl text-4xl font-extrabold tracking-tight text-balance sm:text-5xl">
            Your AI is telling a customer to click a button <Em>that moved.</Em>
          </h2>
          <p className="mt-5 text-lg text-muted-foreground">Connect GitHub, and your next merge fixes it.</p>
          <div className="mt-7 flex flex-wrap justify-center gap-3">
            <Link href={start.href} className={buttonVariants({ size: "lg", className: big })}>
              {start.label}
            </Link>
            <a href={REPO_URL} className={buttonVariants({ size: "lg", variant: "outline", className: big })}>
              View on GitHub
            </a>
          </div>
          <Checks
            items={["Free to start", "Set up in a minute", "Nothing goes out without a hold you can stop", "Self-host anytime"]}
            className="mt-6 justify-center"
          />
        </div>
      </section>

      <footer className="border-t">
        <div className={cn(WRAP, "flex flex-wrap justify-between gap-4 py-7 text-sm text-muted-foreground")}>
          <span className="flex items-center gap-2">
            <TutiMark className="size-5" />
            Tuti is Persian for parrot. It repeats what you ship to everyone who asked.
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
            <a href={REPO_URL} className="hover:text-foreground">
              GitHub
            </a>
            <Link href="/license" className="hover:text-foreground">
              License
            </Link>
          </nav>
        </div>
      </footer>
    </div>
  );
}

/** A tinted band between plain sections. */
function Band({ children }: { children: ReactNode }) {
  return <section className="border-y bg-muted/40">{children}</section>;
}

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

/** Words in a heading in the beak-orange highlight. */
function Em({ children }: { children: ReactNode }) {
  return <span className="text-highlight-foreground">{children}</span>;
}

/** A section's eyebrow, heading and lead. The problem's eyebrow is orange; the answer's are green. */
function Intro({
  id,
  eyebrow,
  title,
  children,
  center = false,
  problem = false,
}: {
  id?: string;
  eyebrow: string;
  title: ReactNode;
  children?: ReactNode;
  center?: boolean;
  problem?: boolean;
}) {
  return (
    <div className={cn("max-w-3xl", center && "mx-auto text-center")}>
      <Eyebrow green={!problem}>{eyebrow}</Eyebrow>
      <h2 id={id} className="mt-3 text-3xl font-extrabold tracking-tight text-balance sm:text-4xl lg:text-[2.75rem] lg:leading-[1.08]">
        {title}
      </h2>
      {children && <p className="mt-4 text-lg text-muted-foreground text-pretty">{children}</p>}
    </div>
  );
}

function Checks({ items, className }: { items: string[]; className?: string }) {
  return (
    <ul className={cn("flex flex-wrap gap-x-5 gap-y-2 text-sm text-muted-foreground", className)}>
      {items.map((item) => (
        <li key={item} className="flex items-center gap-1.5">
          <CheckIcon aria-hidden className="size-4 text-primary" strokeWidth={3} />
          {item}
        </li>
      ))}
    </ul>
  );
}

function Cell({ value }: { value: ReactNode }) {
  if (value === true) return <CheckIcon aria-label="Yes" className="mx-auto size-4 text-primary" strokeWidth={3} />;
  if (value === false) return <MinusIcon aria-label="No" className="mx-auto size-4 text-muted-foreground/60" />;
  return <span className="text-sm font-semibold text-highlight-foreground">{value}</span>;
}

/** The hero's loop: the AI answers from a stale article; a merge rewrites the article; the answer comes right. */
function HeroDemo() {
  return (
    <figure aria-label="An AI answer from an out-of-date article, corrected when a pull request merges" className="flex flex-col gap-3.5">
      <div className="rounded-xl border bg-card p-4 shadow-lg">
        <div className="mb-3.5 flex items-center justify-between text-sm font-bold">
          <span className="flex items-center gap-2">
            <span className="flex size-6.5 items-center justify-center rounded-lg bg-primary text-xs text-primary-foreground">A</span>
            Ask Acme
          </span>
          <span className="text-xs font-normal text-muted-foreground">AI answer</span>
        </div>
        <p className="ml-auto w-fit max-w-[85%] rounded-2xl rounded-br-sm bg-primary px-3.5 py-2 text-sm text-primary-foreground">
          How do I export my data to CSV?
        </p>
        <div className="relative mt-3 h-24 text-sm">
          <p className="landing-stale-answer absolute inset-0 rounded-2xl rounded-bl-sm bg-muted px-3.5 py-3">
            Go to{" "}
            <span className="underline decoration-status-in-progress decoration-wavy decoration-[1.5px] underline-offset-4">Settings → Billing → Export</span>.
            <span className="mt-2 block text-xs font-semibold text-highlight-foreground">From “Exporting data” · last edited 5 months ago</span>
          </p>
          <p className="landing-fresh-answer absolute inset-0 rounded-2xl rounded-bl-sm bg-muted px-3.5 py-3">
            Go to <strong>Settings → Data → Export</strong>.
            <span className="mt-2 block text-xs font-semibold text-soft-foreground">From “Exporting data” · updated by Autopilot today</span>
          </p>
        </div>
      </div>
      <div className="grid items-start gap-3.5 sm:grid-cols-[auto_1fr]">
        <span className="landing-merge inline-flex w-fit items-center gap-1.5 rounded-full bg-foreground px-3 py-1.5 text-xs font-semibold text-background">
          <GitMergeIcon aria-hidden className="size-3.5" /> PR #512 merged
        </span>
        <div className="landing-article rounded-xl border bg-card p-3.5 text-sm shadow-lg">
          <p className="mb-1.5 flex justify-between font-bold">
            Exporting data <span className="text-xs font-normal text-muted-foreground">Help center</span>
          </p>
          <del className="landing-removed block rounded-md bg-destructive/10 px-2 text-destructive">Open Settings → Billing</del>
          <ins className="landing-added block rounded-md bg-soft px-2 text-soft-foreground no-underline">Open Settings → Data</ins>
          <p className="px-2 text-muted-foreground">and click Export CSV.</p>
        </div>
      </div>
    </figure>
  );
}

/**
 * The merge in the middle, its four updates around it, joined by lines drawn in the middle column.
 * The rows are a fixed height (7rem, 4rem apart), so the lines meet each card's middle: 3.5rem
 * and 14.5rem down 18rem, 19.4% and 80.6%.
 */
function MergeFan() {
  const lines = ["M50 50 C 25 50, 25 19.4, 0 19.4", "M50 50 C 75 50, 75 19.4, 100 19.4", "M50 50 C 25 50, 25 80.6, 0 80.6", "M50 50 C 75 50, 75 80.6, 100 80.6"];
  const delay = (i: number): CSSProperties => ({ animationDelay: `${i * 0.25}s` });
  return (
    <div className="mt-14 grid gap-3 lg:grid-cols-[1fr_15rem_1fr] lg:grid-rows-[7rem_7rem] lg:gap-y-16">
      <div className="relative flex items-center justify-center lg:col-start-2 lg:row-span-2 lg:row-start-1">
        <svg aria-hidden viewBox="0 0 100 100" preserveAspectRatio="none" className="absolute inset-0 hidden size-full overflow-visible lg:block">
          {lines.map((d, i) => (
            <path key={d} d={d} pathLength={1} vectorEffect="non-scaling-stroke" className="landing-draw fill-none stroke-primary stroke-2" style={delay(i)} />
          ))}
        </svg>
        <div className="relative rounded-2xl border border-primary/60 bg-card px-5 py-3.5 text-center shadow-[0_0_60px_-10px_var(--primary)]">
          <p className="flex items-center justify-center gap-1.5 text-xs font-bold tracking-wider text-primary uppercase">
            <GitMergeIcon aria-hidden className="size-3.5" /> Merged
          </p>
          <p className="mt-1 font-bold whitespace-nowrap">#482 Add dark mode</p>
          <p className="text-xs text-muted-foreground">acme/app · just now</p>
        </div>
      </div>
      {FAN.map((update, i) => (
        <div key={update.kind} className={cn("landing-light min-w-0 rounded-xl border bg-card px-4.5 py-4", update.place)} style={delay(i)}>
          <p className="mb-1.5 flex justify-between text-xs font-bold tracking-wider text-soft-foreground uppercase">
            {update.kind} <span className="font-medium tracking-normal text-muted-foreground normal-case">{update.when}</span>
          </p>
          <p className="truncate font-semibold">{update.title}</p>
          <p className="truncate text-sm text-muted-foreground">{update.note}</p>
        </div>
      ))}
    </div>
  );
}

/** The email Autopilot sends after a merge: what goes out after the hold, and what waits for you. */
function AutopilotEmail() {
  const updates: { kind: string; title: string; status: string; waits?: boolean }[] = [
    { kind: "Docs", title: "Changing your theme", status: "goes out in 23h" },
    { kind: "Progress", title: "Dark mode → In progress", status: "goes out in 23h" },
    { kind: "Closes", title: "Dark mode · tells 128 voters", status: "needs you", waits: true },
  ];
  return (
    <figure aria-label="Autopilot's email after a merge" className="overflow-hidden rounded-xl border bg-card shadow-lg">
      <div className="flex items-center gap-2.5 border-b px-4.5 py-3.5 text-sm">
        <TutiMark className="size-5.5" />
        <span className="font-bold">Tuti Autopilot</span>
        <span className="ml-auto text-xs text-muted-foreground">9:41 AM</span>
      </div>
      <div className="p-5">
        <p className="font-heading text-lg font-bold tracking-tight">#482 Add dark mode · 2 updates go out tomorrow, 1 needs you</p>
        <ul className="mt-4 flex flex-col gap-2.5">
          {updates.map((update) => (
            <li key={update.title} className="flex items-center gap-3 rounded-lg border bg-background px-3.5 py-3 text-sm">
              <Badge variant={update.waits ? "highlight" : "soft"}>{update.kind}</Badge>
              <span className="min-w-0 flex-1 truncate">{update.title}</span>
              <Badge variant={update.waits ? "highlight" : "soft"} className="rounded-full">
                {update.status}
              </Badge>
            </li>
          ))}
        </ul>
        <div className="mt-4 h-1 overflow-hidden rounded-full bg-muted">
          <div className="landing-hold h-full bg-primary" />
        </div>
        <div className="mt-4 flex gap-2">
          <span className={buttonVariants({ className: "pointer-events-none" })}>Publish now</span>
          <span className={buttonVariants({ variant: "outline", className: "pointer-events-none" })}>Review</span>
          <span className={buttonVariants({ variant: "outline", className: "pointer-events-none" })}>Stop</span>
        </div>
      </div>
    </figure>
  );
}

function Bento() {
  const tile = "flex min-w-0 flex-col gap-2 rounded-xl border bg-card p-6 shadow-sm";
  const text = "text-sm text-muted-foreground";
  const row = "flex items-center gap-2.5 rounded-lg border bg-background px-3 py-2 text-sm";
  return (
    <div className="mt-12 grid gap-4 sm:grid-cols-2 lg:grid-cols-6">
      <div className={cn(tile, "sm:col-span-2 lg:col-span-4")}>
        <h3 className="text-lg font-bold">Feedback that gathers itself</h3>
        <p className={text}>Similar ideas show as people type, so votes pile onto one post instead of five.</p>
        <div className="mt-auto flex flex-col gap-2 pt-3">
          <p className="rounded-lg bg-soft px-3 py-2 text-sm text-soft-foreground">
            Already posted? <strong>Dark mode · 128 votes</strong>
          </p>
          <div className={row}>
            <Votes count={128} voted />
            <span className="flex-1 font-semibold">Dark mode</span>
            <PostStatusBadge status="COMPLETED" />
          </div>
          <div className={row}>
            <Votes count={64} />
            <span className="flex-1 font-semibold">Export posts to CSV</span>
            <PostStatusBadge status="IN_PROGRESS" />
          </div>
        </div>
      </div>
      <div className={cn(tile, "sm:col-span-2 lg:col-span-2 lg:row-span-2")}>
        <h3 className="text-lg font-bold">A widget in your product</h3>
        <p className={text}>Help, ideas, what&apos;s new and messages, behind one button. Your users are already signed in.</p>
        <div className="mx-auto mt-auto w-full max-w-56 overflow-hidden rounded-xl border bg-background pt-0 lg:mr-0">
          <div className="bg-primary px-3 py-3 text-primary-foreground">
            <p className="font-bold">Hi Sam 👋</p>
            <p className="text-xs opacity-85">How can we help?</p>
          </div>
          <div className="flex flex-col gap-1.5 p-2 text-xs">
            <p className="flex items-center gap-1.5 rounded-md border px-2 py-1.5 text-muted-foreground">
              <SearchIcon aria-hidden className="size-3.5" /> Search for help
            </p>
            <div className="rounded-md border px-2 py-1.5">
              <p className="font-semibold">What&apos;s new</p>
              <p className="text-muted-foreground">Dark mode is here</p>
            </div>
            <div className="rounded-md border px-2 py-1.5">
              <p className="font-semibold">Send us a message</p>
              <p className="text-muted-foreground">We reply in about an hour</p>
            </div>
          </div>
        </div>
      </div>
      <div className={cn(tile, "lg:col-span-2")}>
        <h3 className="text-lg font-bold">AI answers you can trust</h3>
        <p className={text}>Only from your articles, with the source. And the articles are current.</p>
      </div>
      <div className={cn(tile, "lg:col-span-2")}>
        <h3 className="text-lg font-bold">See what people can&apos;t find</h3>
        <p className={text}>Searches that found nothing and articles marked unhelpful, so you know what to write next.</p>
      </div>
      <div className={cn(tile, "sm:col-span-2 lg:col-span-3")}>
        <h3 className="text-lg font-bold">An inbox that knows who&apos;s asking</h3>
        <p className={text}>Their plan, their company and the ideas they voted for, beside every conversation.</p>
        <div className="mt-auto flex flex-col gap-2 pt-3">
          <div className={row}>
            <span className="flex-1 font-semibold">Can I export to CSV?</span>
            <Badge variant="highlight">Needs reply · 2h</Badge>
          </div>
          <p className={cn(row, "text-muted-foreground")}>Sam Smith · Acme Corp · Business plan · voted on 3 ideas</p>
        </div>
      </div>
      <div className={cn(tile, "sm:col-span-2 lg:col-span-3")}>
        <h3 className="text-lg font-bold">API and MCP for everything</h3>
        <p className={text}>Ask Claude or Cursor what your users want most. Everything the app does is in the API too.</p>
        <Terminal
          className="mt-auto"
          lines={[
            ["prompt", "What do Business customers ask for most?"],
            ["tool", "posts_list · 3 results"],
            ["comment", "1. Export to CSV · 64 votes · 9 Business customers"],
          ]}
        />
      </div>
    </div>
  );
}

/** A vote count as the portal shows it, not clickable. */
function Votes({ count, voted = false }: { count: number; voted?: boolean }) {
  return (
    <span
      className={cn(
        "flex w-10 flex-col items-center rounded-md border py-0.5 text-sm leading-tight font-bold",
        voted && "border-transparent bg-primary text-primary-foreground",
      )}
    >
      {count}
      <span className="text-[9px] font-medium opacity-70">votes</span>
    </span>
  );
}

/** A terminal, dark in both themes. */
function Terminal({ lines, className }: { lines: ["comment" | "command" | "prompt" | "tool", string][]; className?: string }) {
  return (
    <pre className={cn("dark overflow-x-auto rounded-lg border bg-background p-4 font-mono text-[13px] leading-relaxed text-foreground", className)}>
      {lines.map(([kind, text]) => (
        <span key={text} className={cn("block", kind === "comment" && "text-muted-foreground")}>
          {kind === "command" && <span className="text-primary">$ </span>}
          {kind === "prompt" && <span className="text-muted-foreground">› </span>}
          {kind === "tool" && <span className="text-primary">tuti </span>}
          {text}
        </span>
      ))}
    </pre>
  );
}
