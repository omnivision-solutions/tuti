import { prisma } from "@tuti/db";
import { RichText } from "@tuti/content/react";
import { mediaPublicUrl } from "@tuti/shared/storage";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { EmptyState } from "@/components/empty-state";
import { NewPostForm } from "@/components/new-post-form";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { WidgetClose } from "@/components/widget-close";
import { cn } from "@/lib/utils";
import { displayDoc } from "@/server/content";
import { getSession } from "@/server/session";

export const metadata: Metadata = { robots: { index: false } };

const TABS = [
  { href: "/widget", name: "Feedback" },
  { href: "/widget?tab=whats-new", name: "What's new" },
];

/**
 * What the widget script shows in its iframe on customers' sites: post feedback
 * and read the changelog. Outside the portal's (site) layout, so no header or
 * footer; the only page that other sites may frame (see proxy.ts). Links that
 * leave it open a new tab.
 */
export default async function WidgetPage(props: PageProps<"/portal/[project]/widget">) {
  const { project: slug } = await props.params;
  const whatsNew = (await props.searchParams).tab === "whats-new";
  const project = await prisma.project.findUnique({
    where: { slug },
    select: { boards: { orderBy: { createdAt: "asc" }, take: 1, select: { slug: true } } },
  });
  if (!project) {
    notFound();
  }

  return (
    <main className="flex flex-col gap-4 p-4">
      <div className="flex items-center justify-between border-b">
        <nav className="flex gap-1" aria-label="Widget">
          {TABS.map(({ href, name }, i) => {
            const active = whatsNew === (i === 1);
            return (
              <Link
                key={href}
                href={href}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "border-b-2 px-3 py-2 text-sm whitespace-nowrap transition-colors first:-ml-3",
                  active ? "border-primary font-medium" : "border-transparent text-muted-foreground hover:text-foreground",
                )}
              >
                {name}
              </Link>
            );
          })}
        </nav>
        <WidgetClose />
      </div>
      {whatsNew ? <WhatsNew slug={slug} /> : <Feedback slug={slug} board={project.boards[0]?.slug} />}
    </main>
  );
}

async function Feedback({ slug, board }: { slug: string; board?: string }) {
  if (!board) {
    return <EmptyState title="No boards yet" description="Feedback opens once the team adds a board." />;
  }
  // Portal sessions are per host and their cookies aren't sent to an iframe on another site,
  // so on customers' sites people usually sign in (and post) in a new tab.
  const session = await getSession();
  if (!session) {
    return (
      <div className="flex flex-col items-start gap-3">
        <p className="text-sm text-muted-foreground">Sign in to post ideas and vote. It opens in a new tab.</p>
        <a href="/sign-in" target="_blank" rel="noreferrer" className={buttonVariants()}>
          Sign in to post feedback
        </a>
      </div>
    );
  }
  return <NewPostForm projectSlug={slug} boardSlug={board} mediaBaseUrl={mediaPublicUrl()} linkTarget="_blank" />;
}

async function WhatsNew({ slug }: { slug: string }) {
  const entries = await prisma.changelogEntry.findMany({
    where: { project: { slug }, publishedAt: { not: null } },
    orderBy: [{ publishedAt: "desc" }, { number: "desc" }],
    take: 10,
    select: { number: true, title: true, body: true, content: true, tags: true, publishedAt: true },
  });
  if (entries.length === 0) {
    return <EmptyState title="Nothing new yet" description="Updates from the team show up here." />;
  }
  return (
    <div className="flex flex-col gap-6">
      {entries.map((entry) => (
        <article key={entry.number} className="flex flex-col gap-2">
          <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <time dateTime={entry.publishedAt!.toISOString()}>
              {entry.publishedAt!.toLocaleDateString("en", { dateStyle: "medium" })}
            </time>
            {entry.tags.map((tag) => (
              <Badge key={tag} variant="secondary">
                {tag.charAt(0) + tag.slice(1).toLowerCase()}
              </Badge>
            ))}
          </div>
          <h2 className="font-heading text-lg font-semibold break-words">{entry.title}</h2>
          <RichText doc={displayDoc(entry)} mediaBaseUrl={mediaPublicUrl()} className="rich-text text-sm break-words" />
        </article>
      ))}
    </div>
  );
}
