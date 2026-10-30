import {
  BookOpenIcon,
  ChevronUpIcon,
  GitMergeIcon,
  KeyRoundIcon,
  MapIcon,
  MegaphoneIcon,
  MessageCircleIcon,
  MessageSquareIcon,
  PlugIcon,
  SearchIcon,
  ServerIcon,
  SparklesIcon,
  XIcon,
} from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import type { ReactNode } from "react";

import { ItemList, ItemRow } from "@/components/item-list";
import { PostStatusBadge } from "@/components/post-status-badge";
import { TutiMark } from "@/components/tuti-logo";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { getSession } from "@/server/session";

import { REPO_URL } from "./links";

export const metadata: Metadata = {
  title: "Tuti: feedback, roadmap, changelog and docs, kept up to date as you ship",
  description:
    "Users post and vote, you plan in public, and when a pull request merges Autopilot updates the posts, docs and changelog it changes. Open source: use tuti.so or host it yourself.",
};

/** The loop, in the order it's lived: each part, what it does, and a picture of it drawn with the app's own components. */
const LOOP: { id: string; icon: typeof MessageSquareIcon; title: string; text: string; picture: () => ReactNode }[] = [
  {
    id: "feedback",
    icon: MessageSquareIcon,
    title: "Feedback",
    text: "Users post ideas and vote on your portal. Similar ideas show while they type, so votes gather on one post instead of five, and you see what's wanted most.",
    picture: FeedbackPicture,
  },
  {
    id: "roadmap",
    icon: MapIcon,
    title: "Roadmap",
    text: "Planned, In progress and Completed, in public. Everyone who voted can see where their idea is, without asking.",
    picture: RoadmapPicture,
  },
  {
    id: "autopilot",
    icon: GitMergeIcon,
    title: "Autopilot",
    text: "When a pull request merges, Autopilot reads it and finds what it changes: the requests it closes, the articles now out of date, the line for the changelog. What it's sure of goes out by itself after a hold; the rest waits for you, a click away in your email.",
    picture: AutopilotPicture,
  },
  {
    id: "changelog",
    icon: MegaphoneIcon,
    title: "Changelog",
    text: "Entries drafted from what merged, in your own words. Publishing one tells the people who asked for what it ships.",
    picture: ChangelogPicture,
  },
  {
    id: "docs",
    icon: BookOpenIcon,
    title: "Docs",
    text: "A help center with search that finds the right passage, and answers from AI that only use your articles. You see what people searched for and didn't find.",
    picture: DocsPicture,
  },
  {
    id: "inbox",
    icon: MessageCircleIcon,
    title: "Inbox",
    text: "Conversations from the widget and email in one place, with who's asking beside them: their plan, their company, their ideas.",
    picture: InboxPicture,
  },
  {
    id: "widget",
    icon: SparklesIcon,
    title: "Widget",
    text: "All of it inside your product: help, ideas, what's new and messages, from one button, with your users already signed in.",
    picture: WidgetPicture,
  },
];

const MORE = [
  { icon: KeyRoundIcon, title: "Signed in from your app", text: "Your app signs a token and your users arrive signed in. No second account." },
  { icon: PlugIcon, title: "API and MCP", text: "Everything the app does, over a REST API and an MCP server for AI tools." },
  { icon: ServerIcon, title: "Open source", text: "AGPL-3.0, with Docker images. Run it on your own servers with Postgres and any SMTP provider." },
];

export default async function Home() {
  const session = await getSession();
  const start = session ? { href: "/app", label: "Open app" } : { href: "/sign-up", label: "Get started" };

  return (
    // `data-wide`: the marketing layout gives this page more room than its forms.
    <div data-wide className="flex flex-col gap-20">
      <section className="flex max-w-3xl flex-col items-start gap-5 pt-4">
        <Badge variant="soft">Open source · AGPL-3.0</Badge>
        <h1 className="text-4xl font-bold tracking-tight text-balance sm:text-5xl">Hear what users want. Ship it. Tell them it shipped.</h1>
        <p className="text-lg text-muted-foreground text-pretty">
          Tuti keeps your feedback, roadmap, changelog and docs in one loop, and keeps them up to date as you ship: when a pull request merges, the
          posts it closes, the docs it changes and the people who asked all hear about it. Use it on tuti.so or host it yourself.
        </p>
        <div className="flex flex-wrap gap-3">
          <Link href={start.href} className={buttonVariants({ size: "lg" })}>
            {start.label}
          </Link>
          <a href={REPO_URL} className={buttonVariants({ size: "lg", variant: "outline" })}>
            View on GitHub
          </a>
        </div>
      </section>

      <section id="features" aria-labelledby="loop" className="flex scroll-mt-20 flex-col gap-12">
        <div className="flex max-w-3xl flex-col gap-2">
          <h2 id="loop" className="text-3xl font-bold tracking-tight">
            One loop, from an idea to its answer
          </h2>
          <p className="text-muted-foreground">Seven parts that know about each other, so nothing you ship goes untold.</p>
        </div>
        {LOOP.map(({ id, icon: Icon, title, text, picture: Picture }, i) => (
          <article key={id} id={id} aria-labelledby={`${id}-title`} className="grid scroll-mt-20 items-center gap-6 md:grid-cols-2 md:gap-10">
            <div className={cn("flex flex-col gap-3", i % 2 === 1 && "md:order-last")}>
              <span className="flex size-9 items-center justify-center rounded-lg bg-soft text-soft-foreground">
                <Icon aria-hidden className="size-5" />
              </span>
              <h3 id={`${id}-title`} className="text-2xl font-bold tracking-tight">
                {title}
              </h3>
              <p className="text-muted-foreground text-pretty">{text}</p>
            </div>
            <figure aria-label={`${title}, as it looks in Tuti`} className="rounded-2xl bg-muted/60 p-3 sm:p-5">
              <Picture />
            </figure>
          </article>
        ))}
      </section>

      <section aria-labelledby="more" className="flex flex-col gap-6">
        <h2 id="more" className="text-2xl font-bold tracking-tight">
          And the parts you&apos;d expect
        </h2>
        <ul className="grid gap-4 sm:grid-cols-3">
          {MORE.map(({ icon: Icon, title, text }) => (
            <li key={title}>
              <Card className="h-full gap-2 p-5">
                <Icon className="size-5 text-primary" aria-hidden />
                <h3 className="text-base font-semibold">{title}</h3>
                <p className="text-sm text-muted-foreground">{text}</p>
              </Card>
            </li>
          ))}
        </ul>
      </section>

      <section className="flex flex-col items-start gap-4 rounded-xl bg-soft p-6 text-soft-foreground sm:flex-row sm:items-center">
        <TutiMark className="size-10" />
        <div className="flex-1">
          <h2 className="text-xl font-bold tracking-tight">Start listening today</h2>
          <p className="text-sm">Your first portal takes a minute to set up.</p>
        </div>
        <Link href={start.href} className={buttonVariants()}>
          {start.label}
        </Link>
      </section>

      <footer className="flex flex-wrap justify-between gap-2 border-t pt-6 text-sm text-muted-foreground">
        <span>Tuti is Persian for parrot.</span>
        <a href={REPO_URL} className="hover:text-foreground">
          GitHub
        </a>
      </footer>
    </div>
  );
}

/** A vote count as the portal shows it, not clickable. */
function Votes({ count, voted = false }: { count: number; voted?: boolean }) {
  return (
    <span
      className={buttonVariants({
        variant: voted ? "default" : "outline",
        className: "pointer-events-none h-auto w-12 flex-col gap-0 py-1.5",
      })}
    >
      <ChevronUpIcon aria-hidden />
      <span className="font-semibold tabular-nums">{count}</span>
      <span className="sr-only">votes</span>
    </span>
  );
}

function FeedbackPicture() {
  return (
    <Card size="sm">
      <CardContent className="flex flex-col gap-3">
        <div className="rounded-lg border bg-background px-3 py-2">
          <p className="font-medium">Dark theme</p>
          <p className="mt-2 rounded-md bg-muted/70 px-2 py-1.5 text-xs">
            Already posted? Vote on it instead: <span className="font-medium">Dark mode · 128 votes</span>
          </p>
        </div>
        <ItemList>
          <ItemRow leading={<Votes count={128} voted />} title="Dark mode" meta="24 comments" actions={<PostStatusBadge status="IN_PROGRESS" />} />
          <ItemRow leading={<Votes count={64} />} title="Export posts to CSV" meta="9 comments" actions={<PostStatusBadge status="PLANNED" />} />
          <ItemRow leading={<Votes count={12} />} title="Slack notifications" meta="2 comments" actions={<PostStatusBadge status="UNDER_REVIEW" />} />
        </ItemList>
      </CardContent>
    </Card>
  );
}

function RoadmapPicture() {
  const columns = [
    { status: "PLANNED" as const, cards: [["Export posts to CSV", 64], ["Saved filters", 31]] },
    { status: "IN_PROGRESS" as const, cards: [["Dark mode", 128]] },
    { status: "COMPLETED" as const, cards: [["Keyboard shortcuts", 87], ["Single sign-on", 40]] },
  ];
  return (
    <div className="grid grid-cols-3 gap-2">
      {columns.map((column) => (
        <div key={column.status} className="flex flex-col gap-2">
          <PostStatusBadge status={column.status} />
          {column.cards.map(([title, votes]) => (
            <Card key={title} size="sm" className="gap-1 px-3">
              <p className="text-xs font-medium sm:text-sm">{title}</p>
              <p className="text-xs text-muted-foreground">{votes} votes</p>
            </Card>
          ))}
        </div>
      ))}
    </div>
  );
}

function AutopilotPicture() {
  const updates = [
    { label: "Closes", title: "Dark mode", note: "emails 128 voters", ticked: true },
    { label: "Out of date", title: "Changing your theme", note: "2 paragraphs", ticked: true },
    { label: "Changelog line", title: "Dark mode, everywhere", note: "in the next release", ticked: true },
  ];
  return (
    <Card size="sm">
      <CardContent className="flex flex-col gap-3">
        <div className="flex items-center gap-2 text-sm">
          <GitMergeIcon aria-hidden className="size-4 text-primary" />
          <span className="font-medium">Add dark mode</span>
          <span className="text-muted-foreground">#482 · merged</span>
        </div>
        <ul className="flex flex-col gap-2">
          {updates.map((update) => (
            <li key={update.title} className="flex items-center gap-3 rounded-lg border bg-background px-3 py-2 text-sm">
              <span aria-hidden className="flex size-4 items-center justify-center rounded border border-primary bg-primary text-[10px] text-primary-foreground">
                ✓
              </span>
              <span className="min-w-0 flex-1">
                <span className="text-muted-foreground">{update.label}</span> <span className="font-medium">{update.title}</span>
              </span>
              <span className="text-xs text-muted-foreground">{update.note}</span>
            </li>
          ))}
        </ul>
        <span className={buttonVariants({ className: "pointer-events-none self-end" })}>Approve 3 updates</span>
      </CardContent>
    </Card>
  );
}

function ChangelogPicture() {
  return (
    <Card size="sm">
      <CardContent className="flex flex-col gap-2">
        <div className="flex items-center gap-2">
          <Badge variant="soft">New</Badge>
          <span className="text-xs text-muted-foreground">October 30</span>
        </div>
        <p className="text-lg font-semibold">Dark mode is here</p>
        <p className="text-sm text-muted-foreground">
          Switch to the dark theme from your profile menu. It follows your system&apos;s setting until you pick one.
        </p>
        <p className="text-xs text-muted-foreground">
          Completes <span className="font-medium text-foreground">Dark mode</span> · 128 people told
        </p>
      </CardContent>
    </Card>
  );
}

function DocsPicture() {
  return (
    <Card size="sm">
      <CardContent className="flex flex-col gap-3">
        <div className="flex items-center gap-2 rounded-lg border bg-background px-3 py-2 text-sm text-muted-foreground">
          <SearchIcon aria-hidden className="size-4" />
          <span className="text-foreground">change the theme</span>
        </div>
        <div className="flex items-start gap-2 rounded-lg bg-soft px-3 py-2 text-sm text-soft-foreground">
          <SparklesIcon aria-hidden className="mt-0.5 size-4 shrink-0" />
          <p>Open your profile menu and pick Dark under Theme. From “Changing your theme”.</p>
        </div>
        <ItemList>
          <ItemRow title="Changing your theme" meta="Getting started" />
          <ItemRow title="Keyboard shortcuts" meta="Getting around" />
        </ItemList>
      </CardContent>
    </Card>
  );
}

function InboxPicture() {
  return (
    <Card size="sm">
      <CardContent>
        <ItemList>
          <ItemRow
            title="Can I export to CSV?"
            badges={<Badge variant="highlight">Needs reply · 2h</Badge>}
            meta="Sam Smith · Acme Corp · Business plan"
          />
          <ItemRow title="Dark mode on mobile?" meta="Ana Lee · Globex · Free plan" />
          <ItemRow title="Invoice for October" meta="Kim Park · Initech · Pro plan" />
        </ItemList>
      </CardContent>
    </Card>
  );
}

function WidgetPicture() {
  return (
    <div className="flex justify-end">
      <Card size="sm" className="w-64 gap-0 py-0">
        <div className="flex items-start justify-between bg-primary px-4 py-3 text-primary-foreground">
          <div>
            <p className="font-semibold">Hi Sam 👋</p>
            <p className="text-xs opacity-90">How can we help?</p>
          </div>
          <XIcon aria-hidden className="size-4" />
        </div>
        <div className="flex flex-col gap-2 p-3 text-sm">
          <div className="flex items-center gap-2 rounded-lg border px-2 py-1.5 text-muted-foreground">
            <SearchIcon aria-hidden className="size-4" /> Search for help
          </div>
          <div className="rounded-lg border px-2 py-1.5">
            <p className="font-medium">What&apos;s new</p>
            <p className="text-xs text-muted-foreground">Dark mode is here</p>
          </div>
          <div className="rounded-lg border px-2 py-1.5">
            <p className="font-medium">Send us a message</p>
            <p className="text-xs text-muted-foreground">We usually reply in an hour</p>
          </div>
        </div>
      </Card>
    </div>
  );
}
