import { ChevronUpIcon, CopyIcon, KeyRoundIcon, ListChecksIcon, MailIcon, MessageSquareIcon, ServerIcon } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";

import { ItemList, ItemRow } from "@/components/item-list";
import { PostStatusBadge } from "@/components/post-status-badge";
import { TutiMark } from "@/components/tuti-logo";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { getSession } from "@/server/session";

export const metadata: Metadata = {
  title: "Tuti: open-source feedback boards",
  description:
    "Collect feature requests, let users vote, spot duplicates and tell people when it ships. Use tuti.so or host it yourself.",
};

const REPO_URL = "https://github.com/omnivision-solutions/tuti";

const FEATURES = [
  {
    icon: MessageSquareIcon,
    title: "Boards and votes",
    text: "Users post ideas and bugs on your portal and vote on what matters to them. You see the most wanted first.",
  },
  {
    icon: CopyIcon,
    title: "Duplicates, found for you",
    text: "Tuti suggests similar posts while someone types. With AI turned on, it also flags new posts that repeat an old one, and merging keeps their votes.",
  },
  {
    icon: KeyRoundIcon,
    title: "Signed in from your app",
    text: "Your app signs a token and your users land on the portal already signed in. No second account to make.",
  },
  {
    icon: ListChecksIcon,
    title: "Statuses that close the loop",
    text: "Move posts from Under review to Planned, In progress and Completed, so everyone who voted sees where things stand.",
  },
  {
    icon: MailIcon,
    title: "Your team, invited by email",
    text: "Invite teammates as admins or members. Each project gets its own portal at your-project.tuti.so.",
  },
  {
    icon: ServerIcon,
    title: "Open source, host it anywhere",
    text: "AGPL-licensed, with Docker images for the app and the worker. Run it on your own servers with Postgres and any SMTP provider.",
  },
];

const NEXT = ["Public roadmap", "Changelog, drafted from GitHub", "Docs", "Embeddable widget", "REST API and MCP"];

export default async function Home() {
  const session = await getSession();
  const start = session
    ? { href: "/app", label: "Open app" }
    : { href: "/sign-up", label: "Get started" };

  return (
    <div className="flex flex-col gap-16">
      <section className="flex flex-col items-start gap-5 pt-4">
        <Badge variant="soft">Open source · AGPL-3.0</Badge>
        <h1 className="text-4xl font-bold tracking-tight text-balance sm:text-5xl">
          Hear what your users want. Show them you listened.
        </h1>
        <p className="text-lg text-muted-foreground text-pretty">
          Tuti gives your product a feedback portal: users post and vote, duplicates get caught, and everyone sees
          when their idea ships. Use it on tuti.so or host it yourself.
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

      <ExampleBoard />

      <section aria-labelledby="features" className="flex flex-col gap-6">
        <h2 id="features" className="text-2xl font-bold tracking-tight">
          Everything you need to listen well
        </h2>
        <ul className="grid gap-4 sm:grid-cols-2">
          {FEATURES.map(({ icon: Icon, title, text }) => (
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

      <section aria-labelledby="next" className="flex flex-col gap-4">
        <h2 id="next" className="text-2xl font-bold tracking-tight">
          On the way
        </h2>
        <p className="text-muted-foreground">
          Tuti is growing from feedback into the whole loop: what you plan, what you ship and how to use it.{" "}
          <a href={`${REPO_URL}/blob/main/docs/plan.md`} className="text-primary underline-offset-4 hover:underline">
            Read the plan
          </a>
          .
        </p>
        <ul className="flex flex-wrap gap-2">
          {NEXT.map((item) => (
            <li key={item}>
              <Badge variant="outline">{item}</Badge>
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

const EXAMPLE_POSTS = [
  { votes: 128, title: "Dark mode", meta: "Feature requests · 24 comments", status: "IN_PROGRESS" as const },
  { votes: 64, title: "Export posts to CSV", meta: "Feature requests · 9 comments", status: "PLANNED" as const },
  { votes: 3, title: "Night theme please", meta: "Feature requests · just now", status: "OPEN" as const, duplicate: true },
];

/** A static picture of a portal board, so visitors see the product before signing up. */
function ExampleBoard() {
  return (
    <figure className="flex flex-col gap-2">
      <Card size="sm">
        <CardContent>
          <ItemList>
          {EXAMPLE_POSTS.map((post) => (
            <ItemRow
              key={post.title}
              leading={
                <span
                  className={buttonVariants({
                    variant: post.votes > 100 ? "default" : "outline",
                    className: "pointer-events-none h-auto w-12 flex-col gap-0 py-1.5",
                  })}
                >
                  <ChevronUpIcon aria-hidden />
                  <span className="font-semibold tabular-nums">{post.votes}</span>
                  <span className="sr-only">votes</span>
                </span>
              }
              title={post.title}
              badges={post.duplicate ? <Badge variant="highlight">Possible duplicate</Badge> : undefined}
              meta={post.meta}
              actions={<PostStatusBadge status={post.status} />}
            />
          ))}
          </ItemList>
        </CardContent>
      </Card>
      <figcaption className="text-center text-sm text-muted-foreground">
        A board on a Tuti portal. The newest post repeats “Dark mode”, so Tuti flags it.
      </figcaption>
    </figure>
  );
}
