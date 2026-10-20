import { prisma } from "@tuti/db";
import { mediaPublicUrl } from "@tuti/shared/storage";
import { ExternalLinkIcon } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { ChangelogEntryView } from "@/components/changelog-entry";
import { EmptyState } from "@/components/empty-state";
import { NewPostForm } from "@/components/new-post-form";
import { WidgetClose } from "@/components/widget-close";
import { WidgetFeedback } from "@/components/widget-feedback";
import { WidgetHelp } from "@/components/widget-help";
import { WidgetSeen } from "@/components/widget-seen";
import { cn } from "@/lib/utils";
import { publishedEntries } from "@/server/changelog-queries";
import { widgetSettings } from "@/server/operations/widget";
import { getSession } from "@/server/session";

export const metadata: Metadata = { robots: { index: false } };

const TABS = [
  { tab: "feedback", href: "/widget", name: "Feedback" },
  { tab: "whats-new", href: "/widget?tab=whats-new", name: "What's new" },
  { tab: "help", href: "/widget?tab=help", name: "Help" },
] as const;

/**
 * What the widget script shows in its iframe on customers' sites: post feedback,
 * read the changelog, and search and read the help center (once it has articles).
 * Outside the portal's (site) layout, so no header or footer; the only page that
 * other sites may frame (see proxy.ts). Links that leave it open a new tab.
 */
export default async function WidgetPage(props: PageProps<"/portal/[project]/widget">) {
  const [{ project: slug }, { tab: tabParam, q, article }] = await Promise.all([props.params, props.searchParams]);
  const [project, settings] = await Promise.all([
    prisma.project.findUnique({
      where: { slug },
      select: {
        id: true,
        boards: { orderBy: { createdAt: "asc" }, take: 1, select: { slug: true } },
        articles: { where: { publishedAt: { not: null } }, take: 1, select: { id: true } },
      },
    }),
    widgetSettings({ slug }),
  ]);
  if (!project || !settings) {
    notFound();
  }
  const hasHelp = project.articles.length > 0;
  const tabs = TABS.filter(({ tab }) => tab !== "help" || hasHelp);
  const tab = tabs.find(({ tab }) => tab === tabParam)?.tab ?? "feedback";

  return (
    <main className="flex flex-col gap-4 p-4">
      <div className="flex items-center justify-between border-b">
        <nav className="flex gap-1" aria-label="Widget">
          {tabs.map(({ tab: key, href, name }) => {
            const active = key === tab;
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
      {settings.links.length > 0 && (
        <nav aria-label="Quick links">
          <ul className="flex flex-wrap gap-2">
            {settings.links.map((link, i) => (
              <li key={i}>
                <a
                  href={link.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-sm break-words hover:bg-accent"
                >
                  {link.label}
                  <ExternalLinkIcon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
                </a>
              </li>
            ))}
          </ul>
        </nav>
      )}
      {tab === "whats-new" && <WhatsNew slug={slug} />}
      {tab === "help" && (
        <WidgetHelp
          projectId={project.id}
          projectSlug={slug}
          query={typeof q === "string" ? q.trim().slice(0, 200) : ""}
          article={typeof article === "string" ? article : undefined}
        />
      )}
      {tab === "feedback" && <Feedback slug={slug} board={project.boards[0]?.slug} />}
    </main>
  );
}

async function Feedback({ slug, board }: { slug: string; board?: string }) {
  if (!board) {
    return <EmptyState title="No boards yet" description="Feedback opens once the team adds a board." />;
  }
  // Portal sessions are per host and their cookies aren't sent to an iframe on another site:
  // there, the customer's page signs people in (Tuti.identify), or they sign in in a new tab.
  const session = await getSession();
  if (!session) {
    return <WidgetFeedback projectSlug={slug} boardSlug={board} />;
  }
  return <NewPostForm projectSlug={slug} boardSlug={board} mediaBaseUrl={mediaPublicUrl()} linkTarget="_blank" />;
}

async function WhatsNew({ slug }: { slug: string }) {
  const [recent, announced] = await Promise.all([
    publishedEntries(slug, { take: 10 }),
    prisma.changelogEntry.findFirst({
      where: { project: { slug }, announced: true, publishedAt: { not: null } },
      orderBy: { publishedAt: "desc" },
      select: { number: true, publishedAt: true },
    }),
  ]);
  // The latest announcement is always in the list (after newer quiet ones if need be): it's
  // what the button's "new" dot is about, and opening this tab marks it seen.
  const missing = announced && !recent.some((entry) => entry.number === announced.number);
  const entries = missing ? [...recent, ...(await publishedEntries(slug, { number: announced.number, take: 1 }))] : recent;
  const seen = <WidgetSeen at={announced?.publishedAt?.toISOString() ?? null} />;
  if (entries.length === 0) {
    return <EmptyState title="Nothing new yet" description="Updates from the team show up here." />;
  }
  return (
    <div className="flex flex-col gap-8">
      {seen}
      {entries.map((entry) => (
        <ChangelogEntryView key={entry.number} entry={entry} mediaBaseUrl={mediaPublicUrl()} linkTarget="_blank" />
      ))}
    </div>
  );
}
