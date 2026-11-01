import { prisma } from "@tuti/db";
import { BookOpenIcon, ChevronRightIcon, ExternalLinkIcon, HouseIcon, LightbulbIcon, MegaphoneIcon, MessageCircleIcon, SearchIcon } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { BackLink } from "@/components/back-link";
import { ChangelogEntryView, TAG_LABELS } from "@/components/changelog-entry";
import { PoweredByTuti } from "@/components/portal-look";
import { DocsAssistantProvider } from "@/components/docs-assistant";
import { PortalBaseProvider } from "@/components/portal-base";
import { ChangelogSeen } from "@/components/changelog-seen";
import { EmptyState } from "@/components/empty-state";
import { NewPostForm } from "@/components/new-post-form";
import { WidgetClose } from "@/components/widget-close";
import { WidgetFeedback } from "@/components/widget-feedback";
import { WidgetGreeting, WidgetHomeVisitor, WidgetIdeaNews } from "@/components/widget-home";
import { WidgetDocs } from "@/components/widget-docs";
import { WidgetLocked } from "@/components/widget-locked";
import { WidgetMessages } from "@/components/widget-messages";
import { UnreadCount, UnreadDot, WidgetUnread } from "@/components/widget-whats-new";
import { widgetHeaderStyle } from "@/lib/colors";
import { cn } from "@/lib/utils";
import { docsHref } from "@/lib/widget-docs";
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
import { suggestedArticles, teamFaces, usualReplyMs, whatsNewSeen } from "@/server/widget-home";
import { mediaUrls } from "@/server/media-urls";
import { Avatar, AvatarFallback, AvatarGroup, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { boardTexts } from "@/lib/board-texts";
import { formatDate, initial, replyTime, timeAgo } from "@/lib/format";
import { RichText } from "@tuti/content/react";
import { toPlainText } from "@tuti/content";

export const metadata: Metadata = { robots: { index: false } };

/**
 * The panel's tabs, in the order of the bar at its bottom. Docs is "Help center" here (inside a product,
 * people look for help); the portal's part stays Docs.
 */
const TABS = [
  { tab: "home", href: "/widget", name: "Home", Icon: HouseIcon },
  { tab: "feedback", href: "/widget?tab=feedback", name: "Feedback", Icon: LightbulbIcon },
  { tab: "docs", href: "/widget?tab=docs", name: "Help center", Icon: BookOpenIcon },
  { tab: "messages", href: "/widget?tab=messages", name: "Messages", Icon: MessageCircleIcon },
] as const;

/**
 * What the widget script shows in its iframe on customers' sites: a home with a way into each
 * part (and the changelog, What's new, which opens from it), feedback, the docs (once they have
 * articles) and messages with the team.
 * The panel's own frame: a header, the tab's content scrolling under it, the tabs at the bottom and
 * "Powered by tuti" (unless the project may hide it). Outside the portal's (site) layout; the only
 * page that other sites may frame (see proxy.ts). Links that leave it open a new tab.
 */
export default async function WidgetPage(props: PageProps<"/portal/[project]/widget">) {
  const [{ project: slug }, { tab: tabParam, q, article, docsTab, collection, title, display, entry }] = await Promise.all([props.params, props.searchParams]);
  const [project, settings, brand] = await Promise.all([
    prisma.project.findUnique({
      where: { slug },
      select: {
        id: true,
        name: true,
        boards: { orderBy: { createdAt: "asc" }, take: 1, select: { slug: true, postButton: true, titlePlaceholder: true, detailsPlaceholder: true } },
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
  // What's new isn't a tab: Home opens it (so does `?tab=whats-new`, from Tuti.open and inline mounts), with Home lit in the bar.
  const whatsNew = tabParam === "whats-new";
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
      <WidgetHomeVisitor projectSlug={slug} enabled={tab === "home" && !whatsNew}>
    <main className="flex h-dvh flex-col">
      {css && <style>{css}</style>}
      <header style={widgetHeaderStyle(brand.color)} className={cn("flex flex-col gap-5 px-4 py-2", tab === "home" && !whatsNew && "pb-6")}>
        <div className="flex items-center justify-between gap-2">
          {/* Not a heading: an article in Docs has the page's. */}
          <p className="truncate font-heading text-base font-semibold">{whatsNew ? "What's new" : tab === "home" ? project.name : TABS.find(({ tab: key }) => key === tab)!.name}</p>
          {/* In the header's text colour: the page's focus ring is the project's colour, the header's too. */}
          <WidgetClose
            inline={display === "inline"}
            className="text-current hover:bg-current/15 hover:text-current focus-visible:border-current focus-visible:ring-current/50"
          />
        </div>
        {tab === "home" && !whatsNew && (
          <div className="flex flex-col gap-1">
            <WidgetGreeting />
            <p className="font-heading text-2xl font-bold">How can we help?</p>
          </div>
        )}
      </header>
      {/* What scrolls (a conversation scrolls itself to its newest message here). An update opened from What's new
          starts at its top, and so does the list after it (the same element would keep the scroll). */}
      <div key={whatsNew && typeof entry === "string" ? `entry-${entry}` : "panel"} data-widget-scroll className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-4">
        {tab === "home" && !whatsNew && (
          <Home
            projectId={project.id}
            slug={slug}
            links={settings.links}
            messages={project.supportInbox}
            docs={hasDocs}
            feedback={project.boards.length > 0}
          />
        )}
        {whatsNew &&
          (typeof entry === "string" && /^[1-9]\d{0,8}$/.test(entry) ? (
            <WhatsNewEntry slug={slug} number={Number(entry)} />
          ) : (
            <WhatsNew projectId={project.id} slug={slug} />
          ))}
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
                // In What's new, Home is lit as its section, not the page they're on.
                aria-current={active ? (whatsNew ? "true" : "page") : undefined}
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
      </WidgetHomeVisitor>
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
 * The panel's home: searching for help first, with suggested articles; writing to the team (a few of
 * their faces and when they usually reply); once the page says who's here, the news of their ideas;
 * then feedback, What's new with its latest update, and the team's quick links.
 */
async function Home({
  projectId,
  slug,
  links,
  messages,
  docs,
  feedback,
}: {
  projectId: string;
  slug: string;
  links: { label: string; url: string }[];
  messages: boolean;
  docs: boolean;
  feedback: boolean;
}) {
  const [latest, suggested, faces, replyMs, seen] = await Promise.all([
    prisma.changelogEntry.findFirst({
      where: { project: { slug }, publishedAt: { not: null } },
      orderBy: [{ publishedAt: "desc" }, { number: "desc" }],
      select: { title: true, publishedAt: true },
    }),
    docs ? suggestedArticles(slug) : [],
    messages ? teamFaces(projectId) : [],
    messages ? usualReplyMs(projectId) : null,
    // The portal's signed-in reader's, on its own site (see WhatsNew).
    getSession().then((session) => whatsNewSeen(projectId, session?.user.id ?? null)),
  ]);
  const row = "flex items-center gap-3 px-4 py-3 text-left hover:bg-accent";
  return (
    <div className="flex flex-col gap-3">
      {docs && (
        <div className="flex flex-col gap-2">
          {/* A plain GET form: the Help center tab searches as it opens. */}
          <form action="/widget" role="search" aria-label="Help center" className="flex items-center gap-2 rounded-xl border bg-card px-4 py-1 focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/50">
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
          {suggested.length > 0 && (
            <ul aria-label="Suggested articles" className="flex flex-col divide-y rounded-xl border bg-card">
              {suggested.map((article) => (
                <li key={article.slug}>
                  <Link href={docsHref({ article: article.slug })} className={cn(row, "text-sm break-words first:rounded-t-xl last:rounded-b-xl")}>
                    <span className="min-w-0 flex-1">{article.title}</span>
                    <ChevronRightIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      {messages && (
        <Link href="/widget?tab=messages" className={cn(row, "rounded-xl border bg-card")}>
          {faces.length > 0 && (
            <AvatarGroup aria-hidden>
              {faces.map((face) => (
                <Avatar key={face.id}>
                  {face.image && <AvatarImage src={face.image} alt="" />}
                  <AvatarFallback>{initial(face.name)}</AvatarFallback>
                </Avatar>
              ))}
            </AvatarGroup>
          )}
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="font-medium">Send us a message</span>
            <span className="text-sm text-muted-foreground">
              {replyMs === null ? "We'll reply here and by email" : `Usually replies in ${replyTime(replyMs)}`}
            </span>
          </span>
          <MessageCircleIcon aria-hidden className="size-5 shrink-0 text-primary" />
        </Link>
      )}
      <WidgetIdeaNews />
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
        // "2 new" once the widget's script says what this visitor has seen; the latest update either way.
        <WidgetUnread {...seen}>
          <Link href="/widget?tab=whats-new" className={cn(row, "rounded-xl border bg-card")}>
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="flex items-center gap-2">
                <span className="font-medium">What&apos;s new</span>
                <UnreadCount />
              </span>
              <span className="text-sm break-words text-muted-foreground">
                {latest.title} · {timeAgo(latest.publishedAt!)}
              </span>
            </span>
            <MegaphoneIcon aria-hidden className="size-5 shrink-0 text-primary" />
          </Link>
        </WidgetUnread>
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
  board?: { slug: string; postButton: string | null; titlePlaceholder: string | null; detailsPlaceholder: string | null };
  title?: string;
}) {
  if (!board) {
    return <EmptyState title="No boards yet" description="Feedback opens once the team adds a board." />;
  }
  // Portal sessions are per host and their cookies aren't sent to an iframe on another site:
  // there, the customer's page signs people in (Tuti.identify), or they sign in in a new tab.
  const session = await getSession();
  // The board's own words, as on the portal's box.
  const placeholders = boardTexts(board);
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

/**
 * The changelog, opened from Home's What's new card, with the way back to Home: a card per entry (its date, tags,
 * title, cover, two lines and Read more), the ones published since the visitor last looked marked unread.
 * Showing them marks them seen.
 */
async function WhatsNew({ projectId, slug }: { projectId: string; slug: string }) {
  // Only on the portal's own site: elsewhere its cookies aren't sent, and the page's script
  // records it for people it signs in (Tuti.identify).
  const session = await getSession();
  const [recent, announced, seen] = await Promise.all([
    publishedEntries(slug, { take: 10 }),
    prisma.changelogEntry.findFirst({
      where: { project: { slug }, announced: true, publishedAt: { not: null } },
      orderBy: { publishedAt: "desc" },
      select: { number: true, publishedAt: true },
    }),
    whatsNewSeen(projectId, session?.user.id ?? null),
  ]);
  // The latest announcement and every one that may be unread are always in the list (after newer quiet ones if
  // need be): they're what the button's "new" dot and Home's "2 new" are about, and opening this tab marks them seen.
  const wanted = new Set([...(announced ? [announced.number] : []), ...seen.fresh.map((entry) => entry.number)]);
  const missing = [...wanted].filter((number) => !recent.some((entry) => entry.number === number));
  const entries = [...recent, ...(await Promise.all(missing.map((number) => publishedEntries(slug, { number, take: 1 })))).flat()].sort(
    (a, b) => b.publishedAt.getTime() - a.publishedAt.getTime() || b.number - a.number,
  );
  const at = announced?.publishedAt?.toISOString() ?? null;
  const back = <BackLink href="/widget">Home</BackLink>;
  if (entries.length === 0) {
    return (
      <>
        {back}
        <EmptyState title="Nothing new yet" description="Updates from the team show up here." />
      </>
    );
  }
  const media = await mediaUrls(...entries.map((entry) => entry.cover));
  return (
    <WidgetUnread {...seen} at={at}>
      <ChangelogSeen projectSlug={slug} at={at} signedIn={!!session} />
      <div className="flex flex-col gap-3">
        {back}
        {entries.map((entry) => (
          <article key={entry.number} aria-labelledby={`entry-${entry.number}`} className="overflow-hidden rounded-xl border bg-card">
            {entry.cover && <RichText doc={entry.cover} mediaUrls={media} className="[&_img]:aspect-[2/1] [&_img]:w-full [&_img]:object-cover" />}
            <div className="flex flex-col gap-2 p-4">
              <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
                <UnreadDot number={entry.number} />
                <time dateTime={entry.publishedAt.toISOString()}>{formatDate(entry.publishedAt)}</time>
                {entry.tags.map((tag) => (
                  <Badge key={tag} variant={tag === "BREAKING" ? "destructive" : "secondary"}>
                    {TAG_LABELS[tag]}
                  </Badge>
                ))}
              </div>
              <h2 id={`entry-${entry.number}`} className="font-heading font-semibold break-words">
                {entry.title}
              </h2>
              <p className="line-clamp-2 text-sm break-words text-muted-foreground">{toPlainText(entry.doc).slice(0, 400)}</p>
              <Link href={`/widget?tab=whats-new&entry=${entry.number}`} className="self-start text-sm font-medium text-primary hover:underline">
                Read more<span className="sr-only"> about {entry.title}</span>
              </Link>
            </div>
          </article>
        ))}
      </div>
    </WidgetUnread>
  );
}

/** One entry, from its card's Read more, with the way back to the list. */
async function WhatsNewEntry({ slug, number }: { slug: string; number: number }) {
  const [entry] = await publishedEntries(slug, { number, take: 1 });
  const back = <BackLink href="/widget?tab=whats-new">What&apos;s new</BackLink>;
  if (!entry) {
    return (
      <>
        {back}
        <EmptyState title="This update isn't here" description="It may have been taken down." />
      </>
    );
  }
  return (
    <div className="flex flex-col gap-4">
      {back}
      <ChangelogEntryView entry={entry} heading="h1" mediaUrls={await mediaUrls(entry.doc, entry.cover)} linkTarget="_blank" />
    </div>
  );
}
