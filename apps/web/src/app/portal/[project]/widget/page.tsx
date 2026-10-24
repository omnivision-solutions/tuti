import { prisma } from "@tuti/db";
import { ExternalLinkIcon } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { ChangelogEntryView } from "@/components/changelog-entry";
import { DocsAssistantProvider } from "@/components/docs-assistant";
import { PortalBaseProvider } from "@/components/portal-base";
import { ChangelogSeen } from "@/components/changelog-seen";
import { EmptyState } from "@/components/empty-state";
import { NewPostForm } from "@/components/new-post-form";
import { WidgetClose } from "@/components/widget-close";
import { WidgetFeedback } from "@/components/widget-feedback";
import { WidgetDocs } from "@/components/widget-docs";
import { WidgetLocked } from "@/components/widget-locked";
import { cn } from "@/lib/utils";
import { publishedEntries } from "@/server/changelog-queries";
import { listedArticle } from "@/server/docs-queries";
import { brandCss, branding } from "@/server/operations/branding";
import { MAX_POST_TITLE } from "@/server/operations/create";
import { answersEnabled } from "@/server/operations/docs-ask";
import { askAPerson } from "@/server/operations/docs-escalate";
import { widgetSettings } from "@/server/operations/widget";
import { mayRead } from "@/server/portal-access";
import { getSession } from "@/server/session";
import { mediaUrls } from "@/server/media-urls";

export const metadata: Metadata = { robots: { index: false } };

const TABS = [
  { tab: "feedback", href: "/widget", name: "Feedback" },
  { tab: "whats-new", href: "/widget?tab=whats-new", name: "What's new" },
  { tab: "docs", href: "/widget?tab=docs", name: "Docs" },
] as const;

/**
 * What the widget script shows in its iframe on customers' sites: post feedback,
 * read the changelog, and search and read the docs (once they have articles).
 * Outside the portal's (site) layout, so no header or footer; the only page that
 * other sites may frame (see proxy.ts). Links that leave it open a new tab.
 */
export default async function WidgetPage(props: PageProps<"/portal/[project]/widget">) {
  const [{ project: slug }, { tab: tabParam, q, article, docsTab, collection, title, display }] = await Promise.all([props.params, props.searchParams]);
  const [project, settings, brand] = await Promise.all([
    prisma.project.findUnique({
      where: { slug },
      select: {
        id: true,
        name: true,
        boards: { orderBy: { createdAt: "asc" }, take: 1, select: { slug: true } },
        articles: { where: listedArticle, take: 1, select: { id: true } },
      },
    }),
    widgetSettings({ slug }),
    branding({ slug }),
  ]);
  if (!project || !settings || !brand) {
    notFound();
  }
  // The portal's accent colour; the logo and links are the portal header's, which the panel doesn't have.
  const css = brandCss(brand.color);
  // A private portal shows nothing until whoever's here may read it (see portal-access.ts).
  if (!(await mayRead(project.id))) {
    return (
      <main className="flex flex-col gap-4 p-4">
        {css && <style>{css}</style>}
        <div className="flex justify-end">
          <WidgetClose inline={display === "inline"} />
        </div>
        <WidgetLocked projectSlug={slug} />
      </main>
    );
  }
  // Docs once an article is listed, or when asked for one (Tuti.open({ article }) may open an unlisted one).
  const hasDocs = project.articles.length > 0 || (tabParam === "docs" && typeof article === "string");
  const tabs = TABS.filter(({ tab }) => tab !== "docs" || hasDocs);
  const tab = tabs.find(({ tab }) => tab === tabParam)?.tab ?? "feedback";
  // The docs' assistant, in the panel, when the server has AI answers (asked from the Docs tab).
  const session = answersEnabled() ? await getSession() : null;
  const assistant = answersEnabled()
    ? {
        projectName: project.name,
        viewer: session?.user.id ?? null,
        // "Post this as feedback" opens the Feedback tab, with the question as the title.
        feedbackPath: project.boards.length > 0 ? "/widget" : null,
        askAPerson: await askAPerson(slug),
      }
    : null;

  return (
    <PortalBaseProvider base="" slug={slug}>
      <WithAssistant assistant={assistant}>
    <main className="flex flex-col gap-4 p-4">
      {css && <style>{css}</style>}
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
        <WidgetClose inline={display === "inline"} />
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
      {tab === "docs" && (
        <WidgetDocs
          projectId={project.id}
          projectSlug={slug}
          query={typeof q === "string" ? q.trim().slice(0, 200) : ""}
          article={typeof article === "string" ? article : undefined}
          docsTab={typeof docsTab === "string" ? docsTab : undefined}
          collection={typeof collection === "string" ? collection : undefined}
        />
      )}
      {tab === "feedback" && (
        <Feedback slug={slug} board={project.boards[0]?.slug} title={typeof title === "string" ? title.slice(0, MAX_POST_TITLE) : undefined} />
      )}
    </main>
      </WithAssistant>
    </PortalBaseProvider>
  );
}

/** The panel inside the docs' assistant (widget mode), where the server has AI answers. */
function WithAssistant({ assistant, children }: { assistant: Omit<React.ComponentProps<typeof DocsAssistantProvider>, "children" | "widget"> | null; children: React.ReactNode }) {
  return assistant ? (
    <DocsAssistantProvider {...assistant} widget>
      {children}
    </DocsAssistantProvider>
  ) : (
    children
  );
}

/** The new-post form, starting with `title` (a question from Docs' "Post this as feedback"). */
async function Feedback({ slug, board, title }: { slug: string; board?: string; title?: string }) {
  if (!board) {
    return <EmptyState title="No boards yet" description="Feedback opens once the team adds a board." />;
  }
  // Portal sessions are per host and their cookies aren't sent to an iframe on another site:
  // there, the customer's page signs people in (Tuti.identify), or they sign in in a new tab.
  const session = await getSession();
  if (!session) {
    return <WidgetFeedback projectSlug={slug} boardSlug={board} defaultTitle={title} />;
  }
  return <NewPostForm projectSlug={slug} boardSlug={board} mediaUrls={await mediaUrls()} linkTarget="_blank" defaultTitle={title} />;
}

async function WhatsNew({ slug }: { slug: string }) {
  const [recent, announced, session] = await Promise.all([
    publishedEntries(slug, { take: 10 }),
    prisma.changelogEntry.findFirst({
      where: { project: { slug }, announced: true, publishedAt: { not: null } },
      orderBy: { publishedAt: "desc" },
      select: { number: true, publishedAt: true },
    }),
    // Only on the portal's own site: elsewhere its cookies aren't sent, and the page's script
    // records it for people it signs in (Tuti.identify).
    getSession(),
  ]);
  // The latest announcement is always in the list (after newer quiet ones if need be): it's
  // what the button's "new" dot is about, and opening this tab marks it seen.
  const missing = announced && !recent.some((entry) => entry.number === announced.number);
  const entries = missing ? [...recent, ...(await publishedEntries(slug, { number: announced.number, take: 1 }))] : recent;
  const seen = <ChangelogSeen projectSlug={slug} at={announced?.publishedAt?.toISOString() ?? null} signedIn={!!session} widget />;
  if (entries.length === 0) {
    return <EmptyState title="Nothing new yet" description="Updates from the team show up here." />;
  }
  const media = await mediaUrls(...entries.map((entry) => entry.doc));
  return (
    <div className="flex flex-col gap-8">
      {seen}
      {entries.map((entry) => (
        <ChangelogEntryView key={entry.number} entry={entry} mediaUrls={media} linkTarget="_blank" />
      ))}
    </div>
  );
}
