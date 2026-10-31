import { CheckIcon, GitMergeIcon, MinusIcon } from "lucide-react";
import { plansEnabled } from "@tuti/shared";
import Link from "next/link";
import type { ReactNode } from "react";

import { TutiMark } from "@/components/tuti-logo";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";

import { REPO_URL } from "./links";

/**
 * The landing pages' shared pieces (app/(marketing)/page.tsx and its variants, land-a and land-b):
 * section headings, the hero's demo, Autopilot's page, the footer.
 */

/** A section's content column. */
export const WRAP = "mx-auto w-full max-w-6xl px-6";

/** A tinted band between plain sections. */
export function Band({ children }: { children: ReactNode }) {
  return <section className="border-y bg-muted/40">{children}</section>;
}

export function Eyebrow({ children, green = false }: { children: ReactNode; green?: boolean }) {
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
export function Em({ children }: { children: ReactNode }) {
  return <span className="text-highlight-foreground">{children}</span>;
}

/** A section's eyebrow, heading and lead. The problem's eyebrow is orange; the answer's are green. */
export function Intro({
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

export function Checks({ items, className }: { items: string[]; className?: string }) {
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

export function Cell({ value }: { value: ReactNode }) {
  if (value === true) return <CheckIcon aria-label="Yes" className="mx-auto size-4 text-primary" strokeWidth={3} />;
  if (value === false) return <MinusIcon aria-label="No" className="mx-auto size-4 text-muted-foreground/60" />;
  return <span className="text-sm font-semibold text-highlight-foreground">{value}</span>;
}

/** The hero's loop: the AI answers from a stale article; a merge rewrites the article; the answer comes right. */
export function HeroDemo() {
  return (
    <figure
      aria-label="An AI answer sends a customer to Settings → Billing → Export, from an article last edited 5 months ago. A pull request merges, Autopilot rewrites the article to Settings → Data → Export, and the answer comes right."
      className="flex flex-col gap-3.5"
    >
      <div aria-hidden className="rounded-xl border bg-card p-4 shadow-lg">
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
      <div aria-hidden className="grid items-start gap-3.5 sm:grid-cols-[auto_1fr]">
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


/** Autopilot's page for a merge: what goes out after the hold, and what waits for you. */
export function AutopilotChange() {
  const updates: { kind: string; title: string; status: string; waits?: boolean }[] = [
    { kind: "Docs", title: "Changing your theme", status: "goes out in 23h" },
    // A post under the reach limit (25 people): bigger ones always wait, as "Dark mode" below does.
    { kind: "Progress", title: "Dark mode on mobile → In progress", status: "goes out in 23h" },
    { kind: "Closes", title: "Dark mode · tells 128 voters", status: "needs you", waits: true },
  ];
  return (
    <figure aria-label="Autopilot's page for a merged pull request" className="overflow-hidden rounded-xl border bg-card shadow-lg">
      <div className="flex items-center gap-2.5 border-b px-4.5 py-3.5 text-sm">
        <TutiMark className="size-5.5" />
        <span className="font-bold">Autopilot</span>
        <span className="ml-auto flex items-center gap-1.5 text-xs text-muted-foreground">
          <GitMergeIcon aria-hidden className="size-3.5" /> acme/app#482 · merged 9:41 AM
        </span>
      </div>
      <div className="p-5">
        <p className="font-heading text-lg font-bold tracking-tight">Add dark mode · 2 updates go out tomorrow, 1 needs you</p>
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
          <span className={buttonVariants({ className: "pointer-events-none" })}>Approve</span>
          <span className={buttonVariants({ variant: "outline", className: "pointer-events-none" })}>Publish now</span>
          <span className={buttonVariants({ variant: "outline", className: "pointer-events-none" })}>Stop</span>
        </div>
      </div>
    </figure>
  );
}

/** A vote count as the portal shows it, not clickable. */
export function Votes({ count, voted = false }: { count: number; voted?: boolean }) {
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
export function Terminal({ lines, className }: { lines: ["comment" | "command" | "prompt" | "tool", string][]; className?: string }) {
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

export function Footer({ docs }: { docs: string }) {
  return (
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
        <a href={`${REPO_URL}/blob/main/LICENSE`} className="hover:text-foreground">
          License
        </a>
      </nav>
    </div>
  </footer>
  );
}
