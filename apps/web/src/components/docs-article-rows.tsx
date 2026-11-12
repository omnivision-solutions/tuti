import { prisma } from "@tuti/db";
import { cn } from "cn";
import { ChevronRightIcon, ExternalLinkIcon, FilesIcon, FolderIcon, PlusIcon } from "lucide-react";
import Link from "next/link";
import { cache, type ReactNode } from "react";

import { DeleteCollectionButton } from "@/components/docs";
import { AddContentMenu } from "@/components/docs-tree";
import { LucideIcon } from "@/components/icon-field";
import { CollectionIcon } from "@/components/collection-icon";
import { DocsPageHeader } from "@/components/docs-page-header";
import { portalAddress } from "@/server/custom-domains";
import { FilterPills } from "@/components/filter-pills";
import { buttonVariants } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { SampleBadge } from "@/components/sample-badge";
import { type Listing, LISTING_LABELS } from "@/lib/article-listing";
import { timeAgo } from "@/lib/format";
import { levelSelect } from "@/lib/reader-groups";
import { accessChoices } from "@/server/docs-queries";
import { INSIGHTS_DAYS } from "@/server/operations/docs-insights";
import { accessBadgeFor, articleStats, contentsMeta, type TeamDocs } from "@/server/team-docs";
import { Card } from "@/components/ui/card";

/**
 * What article rows say beyond a title, for DocsArticleRows (once per request). The docs' home fetches
 * it with its other queries; a collection's or a tab's page only when it lists articles.
 */
export const articleRowDetails = cache(async (projectId: string) => {
  const [details, stats, access, saves] = await Promise.all([
    prisma.article.findMany({
      where: { projectId, deletedAt: null },
      select: {
        id: true,
        slug: true,
        title: true,
        publishedAt: true,
        updatedAt: true,
        listing: true,
        sample: true,
        ...levelSelect,
        changes: { select: { articleId: true, updatedAt: true } },
        revisions: { orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: 1, select: { id: true } },
      },
    }),
    articleStats(projectId),
    accessChoices(projectId),
    // When each was last saved (its newest version), in one grouped query: `updatedAt` moves on writes that aren't saves
    // (a move, a tab's access).
    prisma.articleRevision.groupBy({ by: ["articleId"], where: { article: { projectId, deletedAt: null } }, _max: { createdAt: true } }),
  ]);
  return {
    detailsOf: new Map(details.map((d) => [d.slug, d])),
    stats,
    badge: accessBadgeFor(access),
    savedAt: new Map(saves.map((s) => [s.articleId, s._max.createdAt])),
  };
});

export type ArticleRowDetails = Awaited<ReturnType<typeof articleRowDetails>>;

/** An article's state, where it isn't simply out as written: a draft, or published with changes saved but not published. */
export type ArticleState = "draft" | "changes" | "published";

/** The one look of an article's state: a dot in its colour (Draft neutral, Unpublished changes the highlight: it needs the team, Published soft green; never a post status's colour), and its words. */
export const ARTICLE_STATES: Record<ArticleState, { label: string; dot: string; tint: string }> = {
  draft: { label: "Draft", dot: "bg-muted-foreground", tint: "bg-muted" },
  changes: { label: "Unpublished changes", dot: "bg-status-under-review", tint: "bg-highlight" },
  published: { label: "Published", dot: "bg-primary", tint: "bg-soft" },
};

/** An article's state as a tinted pill with its dot (the editor's header). */
export function ArticleStateBadge({ state }: { state: ArticleState }) {
  return (
    <Badge variant="outline" className={cn("border-transparent", state === "changes" ? "text-highlight-foreground" : "text-foreground", ARTICLE_STATES[state ?? "published"].tint)}>
      <span aria-hidden className={cn("size-2 shrink-0 rounded-full", ARTICLE_STATES[state ?? "published"].dot)} />
      {ARTICLE_STATES[state ?? "published"].label}
    </Badge>
  );
}

/** The columns' widths, shared by the header and the rows so the numbers line up. */
const NUMBER = "w-12 shrink-0 text-right tabular-nums sm:w-16";
/** The state column when the page has room; on phones and narrow Docs panes it sits under the title. */
const STATUS = "hidden w-44 shrink-0 sm:block lg:@max-[40rem]/docs-page:hidden";

/** A list of articles' column headings: what the numbers under them count. */
export function ArticleColumns({ first = "Article" }: { first?: string }) {
  return (
    <div className="docs-article-columns flex items-center gap-3 border-b px-1 py-2.5 text-xs text-muted-foreground normal-case tracking-[0] [&_span_>_span]:hidden">
      <span className="flex-1">{first}</span>
      <span className={STATUS}>State</span>
      {/* The window the numbers count, said under them (not only on hover). */}
      <span className={NUMBER}>
        Views<span className="block text-xs font-normal tracking-normal normal-case">{INSIGHTS_DAYS} days</span>
      </span>
      <span className={NUMBER}>
        Helpful<span className="block text-xs font-normal tracking-normal normal-case">{INSIGHTS_DAYS} days</span>
      </span>
      <span className="docs-updated hidden w-20 shrink-0 text-right text-[13px] text-muted-foreground max-sm:hidden">Updated</span>
    </div>
  );
}

/**
 * A group in a list of articles (a collection on the docs' home): its icon, name (a link to its page) and how many
 * articles, then its rows. A region named after it.
 */
export function ArticleGroup({
  name,
  href,
  icon,
  count,
  badges,
  waiting = 0,
  defaultOpen = true,
  children,
}: {
  name: string;
  href?: string;
  icon?: string | null;
  count?: string;
  badges?: ReactNode;
  /** How many in it wait to be published: "N unpublished" on its band. */
  waiting?: number;
  /** Open as the page loads; the band opens or folds it. */
  defaultOpen?: boolean;
  children: ReactNode;
}) {
  return (
    <div role="region" aria-label={name} className="border-b last:border-b-0">
      <details open={defaultOpen} className="group/group">
        <summary className="flex cursor-pointer list-none flex-wrap items-center gap-x-2 gap-y-0.5 bg-muted/50 px-5 py-2.5 hover:bg-muted/80 dark:bg-muted/40 [&::-webkit-details-marker]:hidden">
          <ChevronRightIcon aria-hidden className="size-4 shrink-0 text-muted-foreground transition-transform group-open/group:rotate-90" />
          {icon ? <LucideIcon name={icon} className="size-4 text-muted-foreground" /> : <FilesIcon aria-hidden className="size-4 text-muted-foreground" />}
          <h3 className="min-w-0 text-sm font-semibold">
            {href ? (
              <Link href={href} className="hover:underline">
                {name}
              </Link>
            ) : (
              name
            )}
          </h3>
          {count && <span className="text-xs text-muted-foreground tabular-nums">{count}</span>}
          {badges}
          {waiting > 0 && (
            <span className="ml-auto text-xs text-muted-foreground tabular-nums">{waiting} unpublished</span>
          )}
        </summary>
        {/* Its rows start under its name (past the chevron and icon), so they read as inside it. */}
        <ul className="flex flex-col divide-y pr-5 pl-5 sm:pl-[3.25rem]">{children}</ul>
      </details>
    </div>
  );
}

/** The last row of a collection's articles: write another in it. */
export function NewArticleRow({ href, beside }: { href: string; beside?: ReactNode }) {
  return (
    <li className="flex min-h-10! items-center gap-4">
      <Link href={href} className="flex h-8 items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground">
        <PlusIcon aria-hidden className="size-3.5" />
        New article
      </Link>
      {beside}
    </li>
  );
}

/**
 * Articles as the team's docs list them, in reading order (the tree's): the title, under it its state when it isn't out
 * as written (a dot and "Draft" or "Unpublished changes") and who can read it when that isn't inherited; then its views
 * and how many found it helpful in the last 30 days, as columns (ArticleColumns heads them).
 */
export function DocsArticleRows({
  projectSlug,
  details: { detailsOf, stats, badge, savedAt },
  articles,
  reorder = false,
}: {
  reorder?: boolean;
  projectSlug: string;
  details: ArticleRowDetails;
  articles: { slug: string; title: string }[];
}) {
  return articles.map(({ slug: articleSlug, title }) => {
    const article = detailsOf.get(articleSlug);
    const read = article && stats.get(article.id);
    const state: ArticleState | null = !article ? null : !article.publishedAt ? "draft" : article.changes ? "changes" : null;
    const facts = [
      ...(state ? [state] : []),
      ...(article?.publishedAt && article.listing !== "EVERYWHERE" ? [LISTING_LABELS[article.listing.toLowerCase() as Listing]] : []),
      ...(!state && article?.publishedAt ? ["published"] : []),
    ];
    const access = article && badge(article);
    return (
      <li key={articleSlug} draggable={reorder} data-article-slug={reorder ? articleSlug : undefined} className="flex items-center gap-3 py-2.5 data-[drop-target]:bg-docs-selection">
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
            <Link href={`/app/${projectSlug}/docs/${articleSlug}`} className="min-w-0 text-sm break-words hover:underline">
              {title}
            </Link>
            {article?.sample && <SampleBadge />}
            {access && <Badge variant="outline">{access}</Badge>}
          </div>
          {facts.length > 0 && (
            <div className="flex flex-wrap items-center gap-x-1.5 text-xs text-muted-foreground sm:hidden lg:@max-[40rem]/docs-page:flex">
              {facts.map((fact, i) => (
                <span key={fact} className="inline-flex items-center gap-1.5">
                  {i > 0 && <span aria-hidden>·</span>}
                  {fact in ARTICLE_STATES && <span aria-hidden className={cn("size-1.5 rounded-full", ARTICLE_STATES[fact as ArticleState].dot)} />}
                  {fact in ARTICLE_STATES ? ARTICLE_STATES[fact as ArticleState].label : fact}
                </span>
              ))}
            </div>
          )}
        </div>
        <span className={STATUS}>
          {(state || article?.publishedAt) && (
            <span className={cn("inline-flex items-center gap-1.5 text-[13px]", state === "changes" ? "text-highlight-foreground" : "text-muted-foreground")}>
              <span aria-hidden className={cn("size-1.5 shrink-0 rounded-full", ARTICLE_STATES[state ?? "published"].dot)} />
              {ARTICLE_STATES[state ?? "published"].label}
            </span>
          )}
          {!state && article?.publishedAt && article.listing !== "EVERYWHERE" && (
            <span className="text-xs text-muted-foreground">{LISTING_LABELS[article.listing.toLowerCase() as Listing]}</span>
          )}
        </span>
        {/* The numbers ("–" for none), said in full to the ear (the columns' headings are for the eye). */}
        <span className={cn(NUMBER, "text-sm", !read?.views && "text-muted-foreground")}>
          {read?.views ? read.views.toLocaleString("en") : "–"}
          <span className="sr-only">
            {" "}
            {read?.views === 1 ? "1 view" : `${read?.views ?? 0} views`} in {INSIGHTS_DAYS} days
          </span>
        </span>
        <span className={cn(NUMBER, "text-sm", !read?.helpful && "text-muted-foreground")}>
          {read?.helpful ? read.helpful.toLocaleString("en") : "–"}
          <span className="sr-only"> {read?.helpful ?? 0} found it helpful</span>
        </span>
        <span className="docs-updated hidden w-20 shrink-0 text-right text-[13px] text-muted-foreground max-sm:hidden">{article ? timeAgo(savedAt.get(article.id) ?? article.updatedAt) : "–"}</span>
      </li>
    );
  });
}

/** A collection inside another, as a row of its parent's group: it opens its page. */
function ChildCollectionRow({ projectSlug, child, docs, badge }: { projectSlug: string; child: TeamDocs["collections"][number]; docs: TeamDocs; badge: ArticleRowDetails["badge"] }) {
  return (
    <li className="flex items-center gap-3 py-2.5">
      {child.knownIcon && child.icon ? <LucideIcon name={child.icon} className="size-4 text-muted-foreground" /> : <FolderIcon aria-hidden className="size-4 text-muted-foreground" />}
      <Link href={`/app/${projectSlug}/docs/collections/${child.slug}`} className="min-w-0 flex-1 text-sm font-medium break-words hover:underline">
        {child.name}
      </Link>
      {badge(child) && <Badge variant="outline">{badge(child)}</Badge>}
      <span className="text-xs text-muted-foreground">{contentsMeta(child, docs)}</span>
      <ChevronRightIcon aria-hidden className="size-4 text-muted-foreground" />
    </li>
  );
}

/**
 * A tab's contents as the docs' home and the tab's page list them (`tab` null: the docs without tabs): one card, its
 * columns headed once, each top-level collection a band (icon, name, count) over its articles and the collections in
 * it; `uncollected`, the articles in no collection (the first tab's), last. Null when it has nothing.
 */
export function TabContents({
  projectSlug,
  docs,
  details,
  tab,
  uncollected,
}: {
  projectSlug: string;
  docs: TeamDocs;
  details: ArticleRowDetails;
  tab: string | null;
  uncollected: TeamDocs["uncollected"];
}) {
  const top = docs.collections.filter((c) => c.parent === null && c.tab === tab);
  if (top.length === 0 && uncollected.length === 0) {
    return null;
  }
  const { badge } = details;
  /** How many wait to be published in collection `id`, the collections inside it (at any depth) included. */
  const waitingIn = (id: string): number => {
    const collection = docs.collections.find((c) => c.id === id);
    const own = (collection?.articles ?? []).filter((a) => {
      const d = details.detailsOf.get(a.slug);
      return d && (!d.publishedAt || d.changes);
    }).length;
    return own + docs.collections.filter((c) => c.parentId === id).reduce((sum, c) => sum + waitingIn(c.id), 0);
  };
  return (
    <Card className="gap-0 py-0">
      <ArticleColumns />
      {top.map((c, i) => (
        <ArticleGroup
          key={c.slug}
          // The first open; the rest fold to their band, its count and what waits in it.
          defaultOpen={i === 0}
          waiting={waitingIn(c.id)}
          name={c.name}
          href={`/app/${projectSlug}/docs/collections/${c.slug}`}
          icon={c.knownIcon ? c.icon : null}
          count={contentsMeta(c, docs)}
          badges={
            <>
              {badge(c) && <Badge variant="outline">{badge(c)}</Badge>}
              {c.sample && <SampleBadge />}
            </>
          }
        >
          <DocsArticleRows projectSlug={projectSlug} details={details} articles={c.articles} />
          {docs.collections
            .filter((other) => other.parentId === c.id)
            .map((child) => (
              <ChildCollectionRow key={child.slug} projectSlug={projectSlug} child={child} docs={docs} badge={badge} />
            ))}
        </ArticleGroup>
      ))}
      {uncollected.length > 0 && (
        <ArticleGroup name="Not in a collection" count={`${uncollected.length} ${uncollected.length === 1 ? "article" : "articles"}`}>
          <DocsArticleRows projectSlug={projectSlug} details={details} articles={uncollected} />
        </ArticleGroup>
      )}
    </Card>
  );
}

/**
 * A collection's header, on its page and its settings: its icon and name, its description, Add content (and Delete
 * behind "More actions"), then its views as underline tabs: Content and Settings.
 */
export async function CollectionHeader({
  projectSlug,
  collection,
  hasChildren,
  settings = false,
}: {
  projectSlug: string;
  collection: { slug: string; name: string; description: string; icon: string | null; knownIcon: boolean };
  hasChildren: boolean;
  /** On its Settings tab, whose form has the page's main button (Save): no Add content there. */
  settings?: boolean;
}) {
  const base = `/app/${projectSlug}/docs/collections/${collection.slug}`;
  const portal = await portalAddress(projectSlug);
  return (
    <DocsPageHeader
        back={{ href: `/app/${projectSlug}/docs`, label: "Docs" }}
        title={collection.name}
        icon={collection.knownIcon && collection.icon ? <CollectionIcon name={collection.icon} /> : <FolderIcon />}
        description={collection.description || undefined}
        actions={settings ? <div id="collection-actions" className="flex items-center gap-[8px]" /> : <><a href={`${portal}/docs/${collection.slug}`} target="_blank" rel="noreferrer" className={buttonVariants({ variant: "outline", className: "docs-live-link" })}><ExternalLinkIcon /><span className="@max-[48rem]/app:sr-only">View on help center</span></a><AddContentMenu parent={collection.slug} article={collection.slug} /></>}
        more={settings ? undefined : <DeleteCollectionButton projectSlug={projectSlug} slug={collection.slug} name={collection.name} hasChildren={hasChildren} />}
        filters={
          <FilterPills
            label="Collection"
            items={[
              { title: "Content", href: base },
              { title: "Settings", href: `${base}/settings` },
            ]}
          />
        }
      />
  );
}
