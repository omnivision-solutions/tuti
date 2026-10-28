import { prisma } from "@tuti/db";
import { BookOpenIcon, ChevronRightIcon, ExternalLinkIcon, HouseIcon, LightbulbIcon, MegaphoneIcon, MessageCircleIcon, SearchIcon } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { ChangelogEntryView } from "@/components/changelog-entry";
import { PoweredByTuti } from "@/components/portal-look";
import { DocsAssistantProvider } from "@/components/docs-assistant";
import { PortalBaseProvider } from "@/components/portal-base";
import { ChangelogSeen } from "@/components/changelog-seen";
import { EmptyState } from "@/components/empty-state";
import { NewPostForm } from "@/components/new-post-form";
import { WidgetClose } from "@/components/widget-close";
import { WidgetFeedback } from "@/components/widget-feedback";
import { WidgetDocs } from "@/components/widget-docs";
import { WidgetLocked } from "@/components/widget-locked";
import { WidgetMessages } from "@/components/widget-messages";
import { cn } from "@/lib/utils";
import { publishedEntries } from "@/server/changelog-queries";
import { listedArticle } from "@/server/docs-queries";
import { brandCss, branding } from "@/server/operations/branding";
import { MAX_POST_TITLE } from "@/server/operations/create";
import { answersEnabled } from "@/server/operations/docs-ask";
import { askAPerson } from "@/server/operations/docs-escalate";
import { widgetSettings } from "@/server/operations/widget";
import { canActIn } from "@/server/membership";
import { mayRead } from "@/server/portal-access";
import { getSession } from "@/server/session";
import { mediaUrls } from "@/server/media-urls";
import { Card, CardContent } from "@/components/ui/card";
import { boardTexts } from "@/lib/board-texts";
import { timeAgo } from "@/lib/format";

export const metadata: Metadata = { robots: { index: false } };

/** The panel's tabs, in the order of the bar at its bottom. */
const TABS = [
  { tab: "home", href: "/widget", name: "Home", Icon: HouseIcon },
  { tab: "messages", href: "/widget?tab=messages", name: "Messages", Icon: MessageCircleIcon },
  { tab: "docs", href: "/widget?tab=docs", name: "Docs", Icon: BookOpenIcon },
  { tab: "feedback", href: "/widget?tab=feedback", name: "Feedback", Icon: LightbulbIcon },
  { tab: "whats-new", href: "/widget?tab=whats-new", name: "What's new", Icon: MegaphoneIcon },
] as const;

/**
 * What the widget script shows in its iframe on customers' sites: a home with a way into each
 * part, messages with the team, the docs (once they have articles), feedback and the changelog.
 * The panel's own frame: a header, the tab's content scrolling under it, the tabs at the bottom and
 * "Powered by tuti" (unless the project may hide it). Outside the portal's (site) layout; the only
 * page that other sites may frame (see proxy.ts). Links that leave it open a new tab.
 */
export default async function WidgetPage(props: PageProps<"/portal/[project]/widget">) {
  const [{ project: slug }, { tab: tabParam, q, article, docsTab, collection, title, display }] = await Promise.all([props.params, props.searchParams]);
  const [project, settings, brand] = await Promise.all([
    prisma.project.findUnique({
      where: { slug },
      select: {
        id: true,
        name: true,
        boards: { orderBy: { createdAt: "asc" }, take: 1, select: { slug: true, titlePlaceholder: true, detailsPlaceholder: true } },
        articles: { where: listedArticle, take: 1, select: { id: true } },
        supportInbox: true,
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
  const tabs = TABS.filter(({ tab }) => (tab !== "docs" || hasDocs) && (tab !== "messages" || project.supportInbox));
  const tab = tabs.find(({ tab }) => tab === tabParam)?.tab ?? "home";
  // The docs' assistant, in the panel, when the server has AI answers (asked from the Docs tab).
  const session = answersEnabled() ? await getSession() : null;
  const assistant = answersEnabled()
    ? {
        projectName: project.name,
        viewer: session?.user.id ?? null,
        // "Post this as feedback" opens the Feedback tab, with the question as the title.
        feedbackPath: project.boards.length > 0 ? "/widget?tab=feedback" : null,
        askAPerson: await askAPerson(slug, { widget: true }),
      }
    : null;

  return (
    <PortalBaseProvider base="" slug={slug}>
      <WithAssistant assistant={assistant}>
    <main className="flex h-dvh flex-col">
      {css && <style>{css}</style>}
      <header className="flex items-center justify-between gap-2 border-b px-4 py-2">
        {/* Not a heading: an article in Docs has the page's. */}
        <p className="truncate font-heading text-base font-semibold">{tab === "home" ? project.name : TABS.find(({ tab: key }) => key === tab)!.name}</p>
        <WidgetClose inline={display === "inline"} />
      </header>
      {/* What scrolls (a conversation scrolls itself to its newest message here). */}
      <div data-widget-scroll className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-4">
        {tab === "home" && (
          <Home
            slug={slug}
            links={settings.links}
            messages={project.supportInbox}
            docs={hasDocs}
            feedback={project.boards.length > 0}
          />
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
        {tab === "messages" && <Messages projectId={project.id} slug={slug} />}
        {tab === "feedback" && (
          <Feedback slug={slug} board={project.boards[0]} title={typeof title === "string" ? title.slice(0, MAX_POST_TITLE) : undefined} />
        )}
      </div>
      <footer className="flex flex-col gap-1 border-t pb-2">
        <nav aria-label="Widget" className="flex">
          {tabs.map(({ tab: key, href, name, Icon }) => {
            const active = key === tab;
            return (
              <Link
                key={key}
                href={href}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "flex min-w-0 flex-1 flex-col items-center gap-1 px-1 pt-2.5 pb-1 text-xs transition-colors",
                  active ? "font-semibold text-foreground" : "text-muted-foreground hover:text-foreground",
                )}
              >
                <Icon aria-hidden className={cn("size-5", active && "text-primary")} />
                <span className="max-w-full truncate">{name}</span>
              </Link>
            );
          })}
        </nav>
        {brand.poweredBy && <PoweredByTuti className="self-center" />}
      </footer>
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

/**
 * The panel's home: a greeting, a way into each part the project has (writing to the team, searching
 * the docs, feedback, the latest update) and the team's quick links.
 */
async function Home({
  slug,
  links,
  messages,
  docs,
  feedback,
}: {
  slug: string;
  links: { label: string; url: string }[];
  messages: boolean;
  docs: boolean;
  feedback: boolean;
}) {
  const latest = await prisma.changelogEntry.findFirst({
    where: { project: { slug }, publishedAt: { not: null } },
    orderBy: [{ publishedAt: "desc" }, { number: "desc" }],
    select: { title: true, publishedAt: true },
  });
  const row = "flex items-center gap-3 px-4 py-3 text-left hover:bg-accent";
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-1 rounded-xl bg-primary p-5 text-primary-foreground">
        <p className="text-lg">Hi there 👋</p>
        <p className="font-heading text-2xl font-bold">How can we help?</p>
      </div>
      {messages && (
        <Link href="/widget?tab=messages" className={cn(row, "rounded-xl border bg-card")}>
          <span className="flex flex-1 flex-col">
            <span className="font-medium">Send us a message</span>
            <span className="text-sm text-muted-foreground">We&apos;ll reply here and by email</span>
          </span>
          <MessageCircleIcon aria-hidden className="size-5 shrink-0 text-primary" />
        </Link>
      )}
      {docs && (
        // A plain GET form: the Docs tab searches as it opens.
        <form action="/widget" role="search" aria-label="Docs" className="flex items-center gap-2 rounded-xl border bg-card px-4 py-1 focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/50">
          <input type="hidden" name="tab" value="docs" />
          <input
            type="search"
            name="q"
            aria-label="Search for help"
            placeholder="Search for help"
            maxLength={200}
            className="min-w-0 flex-1 bg-transparent py-2.5 font-medium outline-none placeholder:text-foreground"
          />
          <button type="submit" aria-label="Search" className="shrink-0 text-primary">
            <SearchIcon aria-hidden className="size-5" />
          </button>
        </form>
      )}
      {feedback && (
        <Link href="/widget?tab=feedback" className={cn(row, "rounded-xl border bg-card")}>
          <span className="flex flex-1 flex-col">
            <span className="font-medium">Share an idea</span>
            <span className="text-sm text-muted-foreground">Suggest a feature or report a problem</span>
          </span>
          <ChevronRightIcon aria-hidden className="size-5 shrink-0 text-muted-foreground" />
        </Link>
      )}
      {latest && (
        <Link href="/widget?tab=whats-new" className={cn(row, "rounded-xl border bg-card")}>
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="text-xs text-muted-foreground">Latest update · {timeAgo(latest.publishedAt!)}</span>
            <span className="font-medium break-words">{latest.title}</span>
          </span>
          <ChevronRightIcon aria-hidden className="size-5 shrink-0 text-muted-foreground" />
        </Link>
      )}
      {links.length > 0 && (
        <nav aria-label="Quick links">
          <ul className="flex flex-col divide-y rounded-xl border bg-card">
            {links.map((link, i) => (
              <li key={i}>
                <a href={link.url} target="_blank" rel="noopener noreferrer" className={cn(row, "break-words first:rounded-t-xl last:rounded-b-xl")}>
                  <span className="min-w-0 flex-1 font-medium">{link.label}</span>
                  <ExternalLinkIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
                </a>
              </li>
            ))}
          </ul>
        </nav>
      )}
    </div>
  );
}

/** The new-post form, starting with `title` (a question from Docs' "Post this as feedback"). */
async function Feedback({
  slug,
  board,
  title,
}: {
  slug: string;
  board?: { slug: string; titlePlaceholder: string | null; detailsPlaceholder: string | null };
  title?: string;
}) {
  if (!board) {
    return <EmptyState title="No boards yet" description="Feedback opens once the team adds a board." />;
  }
  // Portal sessions are per host and their cookies aren't sent to an iframe on another site:
  // there, the customer's page signs people in (Tuti.identify), or they sign in in a new tab.
  const session = await getSession();
  const { titlePlaceholder, detailsPlaceholder } = boardTexts(board);
  const placeholders = { titlePlaceholder, detailsPlaceholder };
  if (!session) {
    return <WidgetFeedback projectSlug={slug} boardSlug={board.slug} defaultTitle={title} {...placeholders} />;
  }
  return (
    <Card>
      <CardContent>
        <NewPostForm projectSlug={slug} boardSlug={board.slug} mediaUrls={await mediaUrls()} linkTarget="_blank" defaultTitle={title} {...placeholders} />
      </CardContent>
    </Card>
  );
}

/** Their conversations with the team: signed in on the portal itself, or by the customer's page (Tuti.identify). */
async function Messages({ projectId, slug }: { projectId: string; slug: string }) {
  const session = await getSession();
  return <WidgetMessages projectSlug={slug} portalSignedIn={!!session && (await canActIn(session.user.id, projectId))} />;
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
