import { ARTICLE_TITLE_ID, docHeadings, type Heading } from "@tuti/content";
import { RichText } from "@tuti/content/react";
import type { ApiOperation } from "@tuti/shared/api-reference";
import { prisma } from "@tuti/db";
import { DEFAULT_LANGUAGE } from "@tuti/shared";
import { MESSAGES } from "@tuti/shared/messages";
import { ArrowLeftIcon, ArrowRightIcon, ChevronDownIcon, ChevronRightIcon, LanguagesIcon, LockIcon } from "lucide-react";
import { createTranslator } from "next-intl";
import { headers } from "next/headers";
import Link from "next/link";
import { Fragment } from "react";

import { Method } from "@/components/api-method";
import { ArticleActions, ArticleUpdated } from "@/components/article-actions";
import { ApiReferenceLanding } from "@/components/portal-api-operation";
import { articleLinks } from "@/components/article-links";
import { StillStuck, type SupportContact } from "@/components/docs-assistant";
import { DocsHomeHeader, PopularArticles, PopularChips } from "@/components/docs-home";
import { ReadingModeToggle } from "@/components/docs-reading-mode";
import { DocsSearchBox } from "@/components/docs-search-box";
import { OnThisPage } from "@/components/on-this-page";
import { DocsSidebarLinks, IfSidebarLinks, PortalFooter } from "@/components/portal-look";
import { ArticleFeedback, ArticleViewCount } from "@/components/article-feedback";
import { articleDescription } from "@/lib/article-links";
import { allCollections } from "@/lib/docs-level-above";
import { CodeCopyButtons } from "@/components/code-copy-buttons";
import { CollectionIcon } from "@/components/collection-icon";
import { EmptyState } from "@/components/empty-state";
import { DocsAnswer } from "@/components/docs-answer";
import { ArticleLinks, CollectionContents, LockedMark } from "@/components/docs-collections";
import { PortalPageHeader } from "@/components/portal-page-header";
import { PartRow } from "@/components/portal-nav";
import { SignInLink } from "@/components/sign-in-link";
import { buttonVariants } from "@/components/ui/button";
import { formatDate } from "@/lib/format";
import { CUSTOMIZE } from "@/lib/portal-base";
import { cn } from "@/lib/utils";
import { portalAddress } from "@/server/custom-domains";
import { portalArticleJsonLd } from "@/server/portal-metadata";
import {
  articleCount,
  articleEnd,
  articleMarkdown,
  type DocsArticleLink,
  docsContents,
  type DocsContents,
  type DocsPage,
  type DocsTabView,
  type DocsTree,
  type DocsTreeCollection,
  docsTabPath,
  docsTree,
  everyCollection,
  type LockedArticle,
  shownPopularArticles,
  type TabLanding,
} from "@/server/docs-queries";
import { searchForReader } from "@/server/docs-search";
import { PortalMenuPart } from "@/components/portal-menu";
import { SampleBadge } from "@/components/sample-badge";
import { MAX_POST_TITLE } from "@/server/operations/create";
import { answersEnabled } from "@/server/operations/docs-ask";
import { askAPerson, supportContact } from "@/server/operations/docs-escalate";
import { portalLanguage, portalLinks, teamLanguage } from "@/server/portal-base";
import { pageTranslator } from "@/server/portal-language";
import { mediaUrls } from "@/server/media-urls";
import { firstBoardPath } from "@/server/portal-home";

/** Published articles matching `query`, each with the passage that matched (locked ones by their title, with none). */
async function SearchResults({ projectSlug, query }: { projectSlug: string; query: string }) {
  const at = await portalLinks();
  const project = await prisma.project.findUnique({ where: { slug: projectSlug }, select: { id: true } });
  const results = project ? await searchForReader(project.id, projectSlug, query, 10, { operations: true }) : [];
  const { t } = await pageTranslator("helpCenter");
  // Titles and snippets: the team's words, in the default language under another's address (teamLanguage).
  const lang = await teamLanguage();
  if (results.length === 0) {
    return (
      <EmptyState
        title={t("noMatchFor", { q: query })}
        description={t("tryOther")}
        action={
          <Link href={at("/docs")} className={buttonVariants({ variant: "outline" })}>
            {t("allArticles")}
          </Link>
        }
      />
    );
  }
  return (
    // Rows on the paper.
    <ul aria-label={t("searchResults")} className="flex flex-col">
      {results.map((result) => (
        <li key={result.slug} className="flex flex-col gap-1 border-b py-4 first:pt-0">
          <Link href={at(`/docs/${result.slug}`)} className="text-[1.0625rem] font-semibold break-words hover:underline">
            {/* An API reference's operation: its method first, as the reference's cards list them, and a space after it so
                it's read as a word of its own ("POST Create a post"). */}
            {result.method && (
              <>
                <Method kind={result.method as ApiOperation["kind"]} />{" "}
              </>
            )}
            <span lang={lang}>{result.title}</span>
            {result.locked && <LockedMark />}
          </Link>
          {result.snippet && <p lang={lang} className="text-[0.9375rem] break-words text-muted-foreground">{result.snippet}</p>}
        </li>
      ))}
    </ul>
  );
}

/** The new-post form on the portal's first board, with the question as the title. */
async function feedbackHref(projectSlug: string, question: string) {
  const at = await portalLinks();
  const path = await firstBoardPath(projectSlug);
  return path && at(`${path}?${new URLSearchParams({ title: question.slice(0, MAX_POST_TITLE) })}`);
}

/** A search over every tab (`?q=` on /docs; the box is in the header and on the overviews): an AI answer, when on, and the results. */
export async function DocsSearchResults({ projectSlug, query }: { projectSlug: string; query: string }) {
  return (
    <div className="flex flex-col gap-8">
      <PortalPageHeader title={(await pageTranslator("helpCenter")).t("resultsFor", { q: query })} />
      {answersEnabled() && (
        <DocsAnswer
          key={query}
          projectSlug={projectSlug}
          question={query}
          feedbackHref={await feedbackHref(projectSlug, query)}
          askAPerson={await askAPerson(projectSlug)}
        />
      )}
      <SearchResults projectSlug={projectSlug} query={query} />
    </div>
  );
}

/**
 * A tab's overview (`tab`; without tabs, all of the docs): its name ("Docs" on /docs), its popular
 * articles, a card per top-level collection with how many articles it has, then (the first tab) the
 * articles in none.
 * Searching and asking are the header's box.
 */
async function DocsOverview({ project, docs, tab }: { project: string; docs: DocsContents; tab: DocsTabView | null }) {
  const at = await portalLinks();
  const { collections, uncollected, references } = tab ?? docs;
  // The docs' home (the first tab's overview, or all of the docs) has the team's heading.
  const home = !tab || tab.slug === docs.home;
  // The tab's own popular articles, not another tab's. Customize's preview shows them as its unsaved setting says, so it
  // gets them whatever the saved one.
  const preview = (await headers()).get(CUSTOMIZE.header) === CUSTOMIZE.value;
  const popular = (await shownPopularArticles(project, tab ?? docs, { preview })).map((article) => ({ href: at(`/docs/${article.slug}`), title: article.title }));
  // "Can't find it?": how to reach the team (Ask AI is in the search above it).
  const support = home ? await supportContact(project) : null;
  const { t } = await pageTranslator("helpCenter");
  // The team's words (collections' names and descriptions, references' names, articles' titles): in the default language
  // under another's address (teamLanguage). Not the portal's own text around them.
  const lang = await teamLanguage();
  return (
    <div className="flex flex-col gap-8">
      {/* The home: its heading over a big box for searching and asking (the header's is the same box), and the most-read as chips. */}
      {home ? (
        <div
          data-docs-hero
          className="flex flex-col items-center gap-5 pt-2 pb-2 sm:gap-6 sm:pt-10 sm:pb-4"
        >
          <DocsHomeHeader />
          {/* The header's box gives way to it here (the same box). */}
          <DocsSearchBox askAI={answersEnabled()} hero className="w-full max-w-[46rem]" />
          <PopularChips articles={popular} />
        </div>
      ) : (
        <PortalPageHeader title={tab.name} />
      )}
      {collections.length === 0 && uncollected.length === 0 && references.length === 0 && (
        <EmptyState title={t("empty")} description={t("emptyDescription")} />
      )}
      {collections.length > 0 && (
        <ul aria-label={t("collections")} className="grid gap-4 sm:grid-cols-2">
          {collections.map((collection) => (
            <li key={collection.slug}>
              {/* A card: its icon on a neutral tile beside its name, description and count. */}
              <Link
                href={at(`/docs/${collection.slug}`)}
                className="flex h-full gap-4 rounded-xl bg-card p-5 shadow-card ring-1 ring-card-edge transition-shadow hover:shadow-md sm:px-6"
              >
                {collection.icon && (
                  <span aria-hidden className="grid size-10 shrink-0 place-items-center rounded-lg bg-secondary text-[1.1875rem]">
                    <CollectionIcon name={collection.icon} />
                  </span>
                )}
                <div className="flex min-w-0 flex-1 flex-col gap-1">
                  <h2 className="font-sans text-[1.0625rem] font-semibold break-words">
                    <span lang={lang}>{collection.name}</span>
                    {collection.locked && <LockedMark />}
                  </h2>
                  {collection.sample && <SampleBadge />}
                  {collection.description && <p lang={lang} className="line-clamp-2 text-[0.9375rem] break-words text-muted-foreground">{collection.description}</p>}
                  <div className="mt-auto pt-2">
                    <ArticleCount count={articleCount(collection)} label={t("articleCount", { count: articleCount(collection) })} />
                  </div>
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}
      {references.length > 0 && (
        <ul aria-label={t("apiReferences")} className="grid gap-4 sm:grid-cols-2">
          {references.map((reference) => (
            <li key={reference.slug}>
              <Link
                href={at(`/docs/${reference.slug}`)}
                className="flex h-full flex-col gap-1 rounded-xl bg-card p-5 shadow-card ring-1 ring-card-edge transition-shadow hover:shadow-md sm:px-6"
              >
                <h2 lang={lang} className="font-sans text-[1.0625rem] font-semibold break-words">{reference.name}</h2>
                <p className="text-sm font-medium text-muted-foreground">{t("apiReference")}</p>
              </Link>
            </li>
          ))}
        </ul>
      )}
      <PopularArticles articles={popular} />
      {uncollected.length > 0 && (
        <section aria-labelledby={collections.length > 0 ? "more-articles" : undefined} className="flex flex-col gap-3">
          {collections.length > 0 && (
            <h2 id="more-articles" className="font-sans text-[0.8125rem] font-medium text-muted-foreground">
              {t("moreArticles")}
            </h2>
          )}
          <ArticleLinks articles={uncollected} href={(slug) => at(`/docs/${slug}`)} lang={lang} />
        </section>
      )}
      {support && <StillStuck support={support} home />}
    </div>
  );
}

/** A collection card's "2 articles": what this reader may open in it (none in a locked one, which shows nothing). */
function ArticleCount({ count, label }: { count: number; label: string }) {
  return count > 0 && <p className="text-sm font-medium text-muted-foreground">{label}</p>;
}

/**
 * What a page this reader may not read, but sees with a lock, says in place of what's on it: to
 * sign in (and come back here), or that they don't have access.
 */
export async function LockedMessage({ signedIn }: { signedIn: boolean }) {
  const { t, language } = await pageTranslator("helpCenter");
  return (
    <div className="flex flex-col items-start gap-3 rounded-xl border p-5">
      <p className="flex items-center gap-2 font-medium">
        <LockIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
        {signedIn ? t("noAccess") : t("signInToRead")}
      </p>
      {!signedIn && <SignInLink className={buttonVariants()}>{MESSAGES[language].header.signIn}</SignInLink>}
    </div>
  );
}

/**
 * A tab's path (/docs for the first; `tab` null without tabs): its overview, or the article,
 * collection or API reference it shows in its place; a locked tab, its name and LockedMessage.
 */
export async function DocsTabPage({
  project,
  docs,
  tab,
  landing,
  path,
}: {
  project: string;
  docs: DocsContents;
  tab: DocsTabView | null;
  landing: TabLanding;
  /** Its own path (/docs, or /docs/<tab>): the canonical one of the article it shows. */
  path: string;
}) {
  if (tab?.locked) {
    return (
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-8">
        <PortalPageHeader title={tab.slug !== docs.home ? tab.name : MESSAGES[(await pageTranslator("helpCenter")).language].header.docs} />
        <LockedMessage signedIn={docs.signedIn} />
        <PortalFooter docs />
      </div>
    );
  }
  switch (landing.kind) {
    case "article":
      return <DocsArticle project={project} slug={landing.slug} article={landing.article} path={path} />;
    case "collection":
      return <DocsCollectionPage page={landing} />;
    case "reference":
      return <ApiReferenceLanding project={project} slug={landing.slug} />;
    case "overview":
      // Its cards are the collections: no tree beside them.
      return (
        <DocsLayout tree={null} current={null} overview>
          <DocsOverview project={project} docs={docs} tab={tab} />
        </DocsLayout>
      );
  }
}

/**
 * An article's or collection's search listing and link card (portalPageMetadata: the caller adds its path). A locked
 * one: its title only, and not for search engines.
 */
export function docsPageListing(page: Extract<DocsPage, { kind: "article" | "locked" | "collection" }>) {
  if (page.kind === "locked") {
    return { title: `${page.article.title} · Documentation`, noindex: true };
  }
  if (page.kind === "collection") {
    const { name, description, locked, sample } = page.collection;
    return { title: `${name} · Documentation`, description, noindex: locked || sample };
  }
  const { article } = page;
  return {
    title: article.title,
    description: articleDescription(article),
    article: { publishedTime: article.publishedAt, modifiedTime: article.updatedAt ?? article.publishedAt },
    // Unlisted: for people with the link, not search engines; nor one whose team blocked search indexing, nor sample content.
    noindex: article.listing === "UNLISTED" || article.noindex || article.sample,
  };
}

/** A collection's page: its articles, then the collections in it. */
export async function DocsCollectionPage({ page }: { page: Extract<DocsPage, { kind: "collection" }> }) {
  const at = await portalLinks();
  const { docs, tab, parent, collection } = page;
  // The level above: the collection it's in, else its tab or all of them.
  const up = parent ? { href: `/docs/${parent.slug}`, label: parent.name } : allCollections(docs, tab, (await pageTranslator("helpCenter")).t("allCollections"));
  // The team's words (its and its parent's names, its description, its articles): in the default language under another's
  // address (teamLanguage).
  const lang = await teamLanguage();
  return (
    <DocsLayout tree={docsTree(docs, tab?.slug ?? null, collection.slug)} current={collection.slug}>
      <div className="flex flex-col gap-8">
        <div className="flex flex-col gap-6">
          <Link lang={parent ? lang : undefined} href={at(up.href)} className="self-start text-sm font-medium text-primary hover:underline">
            {up.label}
          </Link>
          <PortalPageHeader
            title={
              // Its icon before its name.
              <span className="flex items-center gap-3">
                {collection.icon && (
                  <span className="text-muted-foreground">
                    <CollectionIcon name={collection.icon} />
                  </span>
                )}
                <span lang={lang} className="min-w-0">
                  {collection.name}
                </span>
              </span>
            }
            description={collection.description && <span lang={lang}>{collection.description}</span>}
          />
          {collection.sample && <SampleBadge />}
        </div>
        {collection.locked ? (
          <LockedMessage signedIn={docs.signedIn} />
        ) : (
          <CollectionContents
            collection={collection}
            href={(s) => at(`/docs/${s}`)}
            collectionHref={(s) => at(`/docs/${s}`)}
            lang={lang}
            articlesLabel={(await pageTranslator("helpCenter")).t("articles")}
          />
        )}
      </div>
    </DocsLayout>
  );
}

/**
 * Article `slug`'s page (at its own path, or a tab's showing it). A locked one (LockedArticle) has
 * its title, and LockedMessage in place of everything it says.
 */
export async function DocsArticle({
  project,
  slug,
  article,
  path = `/docs/${slug}`,
  own = slug,
}: {
  project: string;
  /** Its default-language slug. */
  slug: string;
  article: Extract<DocsPage, { kind: "article" }>["article"] | LockedArticle;
  /** Its canonical path: a tab showing it in its place, the tab's. */
  path?: string;
  /** Its slug at this address (its slug in the address's language, where it has one). */
  own?: string;
}) {
  const [at, lang, { language: pageLanguage, prefix, defaultLanguage }] = await Promise.all([portalLinks(), teamLanguage(), portalLanguage()]);
  // Its own words are in its version's language here, or the default language's (docs/plan.md, "A page not yet translated"),
  // with a line in the page's language saying so.
  const textLang = article.language ?? lang;
  // Translated here: its search data is its address here (as its canonical is); a tab showing it keeps the tab's.
  const ownPath = prefix && !article.untranslated ? `${prefix}${path === `/docs/${slug}` ? `/docs/${own}` : path}` : path;
  const notTranslated = article.untranslated && pageLanguage ? createTranslator({ locale: pageLanguage, messages: MESSAGES[pageLanguage], namespace: "docs" })("notTranslated") : null;
  const readable = "doc" in article ? article : null;
  // Its tab and collection have pages for this reader when they have something to read (an unlisted
  // article may be all there is): the way back is its tab's, or /docs.
  const docs = await docsContents(project);
  const tab = docs.tabs.find((t) => t.slug === article.tab);
  const collection = article.collection && everyCollection(docs.collections).find((c) => c.slug === article.collection!.slug);
  // The tree: its tab's (the first tab's has the articles in none), its collection's branch open.
  const tree = docsTree(docs, article.tab ?? docs.home, article.collection?.slug ?? null);
  const headings = readable ? docHeadings(readable.doc) : [];
  const up = collection ? { href: `/docs/${collection.slug}`, label: collection.name } : allCollections(docs, tab, (await pageTranslator("helpCenter")).t("allCollections"));
  // The way up's own words, in the page's language.
  const crumbs = { docs: (await pageTranslator("header")).t("docs"), label: (await pageTranslator("helpCenter")).t("breadcrumb") };
  // Its search data's breadcrumb is its canonical page's: translated, this address's words and addresses; else the
  // default language's, as that page says it.
  const searchLanguage = prefix && article.untranslated ? (defaultLanguage ?? DEFAULT_LANGUAGE) : (pageLanguage ?? DEFAULT_LANGUAGE);
  const searchWords = MESSAGES[searchLanguage];
  const search = {
    docs: createTranslator({ locale: searchLanguage, messages: searchWords, namespace: "header" })("docs"),
    up: collection ? up : allCollections(docs, tab, createTranslator({ locale: searchLanguage, messages: searchWords, namespace: "helpCenter" })("allCollections")),
    prefix: prefix && !article.untranslated ? prefix : "",
  };
  const markdown = readable && (await articleMarkdown(readable));
  // How long it takes to read, at about 200 words a minute.
  const minutes = markdown ? Math.max(1, Math.round(markdown.split(/\s+/).filter(Boolean).length / 200)) : null;
  // For search engines, when it's for them and every signed-out reader: its breadcrumb as shown, Documentation first.
  const listing = readable && docsPageListing({ kind: "article", article: readable });
  const jsonLd =
    readable &&
    listing &&
    !listing.noindex &&
    !readable.restricted &&
    (await portalArticleJsonLd(project, {
      type: "TechArticle",
      title: readable.title,
      description: listing.description,
      path: ownPath,
      published: readable.publishedAt,
      modified: readable.updatedAt,
      // A tab showing it in its place is its own page: no step for it.
      breadcrumb: [
        ...[{ name: search.docs, path: "/docs" }, { name: search.up.label, path: search.up.href }]
          .filter((crumb, i) => (i === 0 || crumb.path !== "/docs") && crumb.path !== path)
          .map((crumb) => ({ ...crumb, path: `${search.prefix}${crumb.path}` })),
        { name: readable.title, path: ownPath },
      ],
    }));
  return (
    <DocsLayout
      tree={tree}
      current={slug}
      headings={headings}
      headingsLang={textLang}
      reading={!!readable && outlined(headings)}
    >
      {jsonLd}
      {/* The team's words (its title, text and headings, its collection's name, the articles around it) carry the default
          language's `lang` under another's address (teamLanguage); the portal's own text around them doesn't. */}
      <article className="flex flex-col gap-6" aria-labelledby={ARTICLE_TITLE_ID}>
        <div className="flex flex-col gap-3">
          {/* The way up (Docs, then its collection, when it has a page for this reader; an unlisted article may be all it
              has), the actions at the row's end on wide screens, under the title on phones. */}
          <div className="flex flex-wrap items-center justify-between gap-3">
            <nav aria-label={crumbs.label} className="flex min-w-0 items-center gap-1.5 text-sm text-muted-foreground">
              {up.href !== "/docs" && (
                <>
                  <Link href={at("/docs")} className="hover:text-foreground">
                    {crumbs.docs}
                  </Link>
                  <ChevronRightIcon aria-hidden className="size-3.5 shrink-0" />
                </>
              )}
              <Link lang={collection ? lang : undefined} href={at(up.href)} className="truncate font-medium text-foreground hover:underline">
                {up.label}
              </Link>
            </nav>
            {readable && markdown && (
              <div className="flex items-center gap-2 max-sm:hidden">
                {/* On an article with sections (one long enough to want it), from tablet width, where the tree is beside it. */}
                {outlined(headings) && (
                  <span className="max-md:hidden">
                    <ReadingModeToggle />
                  </span>
                )}
                <ArticleActions markdown={markdown} markdownUrl={`${await portalAddress(project)}${prefix}/docs/${own}.md`} />
              </div>
            )}
          </div>
          {notTranslated && (
            <p lang={pageLanguage ?? undefined} className="flex items-start gap-2 rounded-lg bg-secondary px-3 py-2 text-sm text-muted-foreground">
              <LanguagesIcon aria-hidden className="mt-0.5 size-4 shrink-0" />
              {notTranslated}
            </p>
          )}
          <h1 lang={textLang} id={ARTICLE_TITLE_ID} className="font-heading text-[1.75rem] leading-[1.15] font-[650] tracking-[-0.025em] break-words sm:text-[2.25rem]">
            {article.title}
          </h1>
          {readable?.sample && <SampleBadge />}
          {readable && (
            <p className="flex flex-wrap items-center gap-x-2 text-sm text-muted-foreground">
              {readable.updatedAt && <ArticleUpdated at={readable.updatedAt.toISOString()} label={formatDate(readable.updatedAt)} />}
              {minutes && (
                <span className="inline-flex items-center gap-2 [&:not(:first-child)]:before:content-['·']">
                  {minutes} min read
                </span>
              )}
            </p>
          )}
          {/* On phones the page's actions under its title and dates, only as wide as their buttons. */}
          {readable && markdown && (
            <div className="w-fit sm:hidden">
              <ArticleActions markdown={markdown} markdownUrl={`${await portalAddress(project)}${prefix}/docs/${own}.md`} />
            </div>
          )}
          {/* Where "On this page" isn't beside it (below wide screens, or in reading mode), a compact menu under the title. */}
          {readable && outlined(headings) && (
            <details className="group/toc mt-1 text-sm xl:hidden xl:[:root[data-docs-reading]_&]:block">
              <summary className="inline-flex cursor-pointer list-none items-center gap-1.5 rounded-lg bg-secondary px-3 py-1.5 font-medium text-muted-foreground hover:text-foreground [&::-webkit-details-marker]:hidden">
                On this page
                <ChevronDownIcon aria-hidden className="size-4 transition-transform group-open/toc:rotate-180" />
              </summary>
              <ul lang={textLang} className="mt-2 flex w-fit max-w-full min-w-64 flex-col rounded-lg border border-border bg-card p-1.5 shadow-sm">
                {headings.map((heading) => (
                  <li key={heading.id}>
                    <a href={`#${heading.id}`} className={cn("block rounded-md px-2 py-1.5 text-muted-foreground hover:text-foreground", heading.level === 3 && "pl-5")}>
                      {heading.text}
                    </a>
                  </li>
                ))}
              </ul>
            </details>
          )}
        </div>
        {readable ? (
          <>
            <RichText
              lang={textLang}
              doc={readable.doc}
              mediaUrls={await mediaUrls(readable.doc)}
              headingIds
              // Its links to the portal's other docs pages stay here, under this address, in this tab.
              link={await articleLinks(project, readable.doc, ({ slug, hash }) => `${at(`/docs/${slug}`)}${hash}`)}
              // On the portal a step brighter and closer than the shared reading style: it's the page's whole point.
              className="rich-text article-text gap-4 break-words text-foreground"
            />
            <CodeCopyButtons />
            <ArticleViewCount projectSlug={project} slug={slug} />
            <ArticleFeedback projectSlug={project} slug={slug} className="mt-4" />
            <ArticleEnd end={await articleEnd(project, slug, article.collection?.slug ?? null, readable.tab, docs)} support={await supportContact(project)} lang={lang} />
          </>
        ) : (
          <LockedMessage signedIn={"signedIn" in article && article.signedIn} />
        )}
      </article>
    </DocsLayout>
  );
}

/** The end of an article: the previous and next ones in reading order, related ones (articleEnd), and "Still stuck?". */
async function ArticleEnd({ end, support, lang }: { end: Awaited<ReturnType<typeof articleEnd>>; support: SupportContact | null; lang?: string }) {
  const at = await portalLinks();
  const step = (article: DocsArticleLink, rel: "prev" | "next") => (
    <Link
      href={at(`/docs/${article.slug}`)}
      rel={rel}
      className={cn(
        "flex flex-col gap-1 rounded-xl bg-card p-4 shadow-card ring-1 ring-card-edge transition-shadow hover:shadow-md",
        rel === "next" && "sm:col-start-2 sm:items-end sm:text-right",
      )}
    >
      <span className="flex items-center gap-1 text-sm text-muted-foreground">
        {rel === "prev" ? (
          <>
            <ArrowLeftIcon aria-hidden className="size-3.5" />
            Previous
          </>
        ) : (
          <>
            Next
            <ArrowRightIcon aria-hidden className="size-3.5" />
          </>
        )}
      </span>
      <span lang={lang} className="font-medium break-words">
        {article.title}
      </span>
    </Link>
  );
  return (
    <>
      {(end.previous || end.next) && (
        <nav aria-label="Previous and next" className="grid gap-3 sm:grid-cols-2">
          {end.previous && step(end.previous, "prev")}
          {end.next && step(end.next, "next")}
        </nav>
      )}
      {end.related.length > 0 && (
        <section aria-labelledby="related-articles" className="flex flex-col gap-3">
          <h2 id="related-articles" className="font-sans text-[0.8125rem] font-medium text-muted-foreground">
            Related articles
          </h2>
          <ArticleLinks articles={end.related} href={(s) => at(`/docs/${s}`)} lang={lang} />
        </section>
      )}
      <StillStuck support={support} />
    </>
  );
}

/** Docs' row under the header: its tabs with something to read (with two or more), `active` the one this page is in. */
export async function DocsTabsRow({ docs, active }: { docs: DocsContents; active: string | null }) {
  const at = await portalLinks();
  const links = docs.tabs.map((tab) => ({ href: at(docsTabPath(docs, tab.slug)), name: tab.name, active: tab.slug === active, locked: tab.locked }));
  return <PartRow label={(await pageTranslator("helpCenter")).t("docsTabs")} links={links} />;
}

/**
 * The tab's collections (docsTree): top-level ones always open, the ones in them collapsible
 * (`<details>`, so it works without JavaScript), then the articles in none under "More".
 * `current` is the page's slug (one name per page under /docs), marked as the current page.
 */
async function DocsTree({ tree, current, extra }: { tree: DocsTree; current: string | null; extra?: React.ReactNode }) {
  const at = await portalLinks();
  // The team's names and titles: in the default language under another's address (teamLanguage).
  const lang = await teamLanguage();
  // One line each, a long name cut short (in full on hover).
  const link = (slug: string, title: string, name: React.ReactNode, className?: string) => (
    <Link
      href={at(`/docs/${slug}`)}
      title={title}
      aria-current={slug === current ? "page" : undefined}
      className={cn(
        "flex items-center rounded-lg px-2.5 py-1.5 text-muted-foreground transition-colors hover:text-foreground aria-[current=page]:bg-accent aria-[current=page]:font-medium aria-[current=page]:text-foreground",
        className,
      )}
    >
      {name}
    </Link>
  );
  // A collection's name, after its icon.
  const named = (collection: DocsTreeCollection) => (
    <>
      <CollectionIcon name={collection.icon} />
      {locked(collection.name, collection.locked)}
    </>
  );
  // A page's name, with a lock if it's locked for this reader (kept in view when the name is cut short).
  const locked = (name: string, isLocked?: boolean) => (
    <>
      <span lang={lang} className="min-w-0 break-words">
        {name}
      </span>
      {isLocked && <LockedMark />}
    </>
  );
  const references =
    extra ??
    (tree.references.length > 0 &&
      tree.references.map((reference) => (
        <Fragment key={reference.slug}>{link(reference.slug, reference.name, <span lang={lang} className="min-w-0 break-words">{reference.name}</span>, "font-medium text-foreground")}</Fragment>
      )));
  const articles = (list: DocsTree["uncollected"]) => list.map((article) => <li key={article.slug}>{link(article.slug, article.title, locked(article.title, article.locked))}</li>);
  const contents = (collection: DocsTreeCollection) => (
    <ul className="flex flex-col gap-0.5">
      {articles(collection.articles)}
      {collection.collections.map((child) => (
        <li key={child.slug}>
          <details open={child.open}>
            <summary className="flex cursor-pointer list-none items-center rounded-md hover:bg-muted [&::-webkit-details-marker]:hidden">
              <ChevronRightIcon aria-hidden className="ml-1 size-4 shrink-0 text-muted-foreground transition-transform [[open]>summary>&]:rotate-90" />
              {link(child.slug, child.name, named(child), "min-w-0 flex-1 gap-2 pl-1")}
            </summary>
            <div className="ml-3 pl-2">{contents(child)}</div>
          </details>
        </li>
      ))}
    </ul>
  );
  return (
    <nav aria-label={(await pageTranslator("helpCenter")).t("docsNav")} className="flex flex-col gap-1 text-[0.9375rem]">
      <DocsSidebarLinks className="mb-3 border-b pb-4" />
      {/* Each collection a row that opens (`<details>`, so it works without JavaScript): the page's own open. */}
      {tree.collections.map((collection) => (
        <details key={collection.slug} open={collection.open} className="group/collection">
          <summary className="flex cursor-pointer list-none items-center rounded-lg hover:bg-muted [&::-webkit-details-marker]:hidden">
            {link(collection.slug, collection.name, named(collection), "min-w-0 flex-1 gap-2.5 font-medium text-foreground [&>svg]:size-4 [&>svg]:text-muted-foreground")}
            <ChevronRightIcon aria-hidden className="mr-2 size-4 shrink-0 text-muted-foreground transition-transform group-open/collection:rotate-90" />
          </summary>
          <div className="my-1 ml-[1.0625rem] pl-2.5">{contents(collection)}</div>
        </details>
      ))}
      {/* The tab's API references, after its collections: a link each, or (on a reference's pages) `extra`. */}
      {references && <div className={cn("flex flex-col gap-1", tree.collections.length > 0 && "mt-3 border-t pt-4")}>{references}</div>}
      {tree.uncollected.length > 0 && (
        <ul className={cn("flex flex-col gap-0.5", (tree.collections.length > 0 || references) && "mt-4 border-t pt-4")}>{articles(tree.uncollected)}</ul>
      )}
    </nav>
  );
}

/**
 * Every Docs page's columns: the tab's tree on the left (on phones and tablets, in the header's
 * menu instead), the page, and on an article its `headings` on the right ("On this page", on wide
 * screens, with two or more).
 */
/** What reading mode hides (from tablet width: on phones the tree is in the menu anyway). */
const READING_HIDES = "md:[:root[data-docs-reading]_&]:hidden";

/** Whether an article with `headings` gets "On this page" beside it (on wide screens). */
const outlined = (headings: Heading[]) => headings.length >= 2;

export async function DocsLayout({
  tree,
  current,
  overview = false,
  headings = [],
  headingsLang,
  reading = false,
  extra,
  wide = false,
  children,
}: {
  /** What `headings` are in (the article's text's language), for screen readers. */
  headingsLang?: string;
  /** Null for none (a tab's overview, whose cards are its collections). */
  tree: DocsTree | null;
  current: string | null;
  /** A tab's overview: its collection cards fill the container from desktop width up. */
  overview?: boolean;
  headings?: Heading[];
  /** An article's page with sections: in reading mode (ReadingModeToggle) the tree and "On this page" go. */
  reading?: boolean;
  /** In the tree after the collections, in place of the tab's references: the reference's own part (its pages). */
  extra?: React.ReactNode;
  /** An operation's page: from desktop width the page takes the room "On this page" would, for its examples beside it. */
  wide?: boolean;
  children: React.ReactNode;
}) {
  const shown = tree && (tree.collections.length > 0 || tree.uncollected.length > 0 || tree.references.length > 0 || extra) ? tree : null;
  // Without a tree (a tab's overview), the team's sidebar links alone, where it has some.
  const nav = shown ? <DocsTree tree={shown} current={current} extra={extra} /> : <DocsSidebarLinks />;
  const column = (node: React.ReactNode) => (shown ? node : <IfSidebarLinks>{node}</IfSidebarLinks>);
  // Keep the desktop columns (and header) in place when moving between articles. Short articles keep their 43rem
  // measure, aligned to the longer article's left edge, with empty space where its outline would be.
  const sections = outlined(headings);
  // The tree's toggle without JavaScript, in the page's language.
  const browse = (await pageTranslator("helpCenter")).t("browseDocs");
  return (
    // At least the window's height (flex-1 in <main>), so the tree runs to the bottom on a short page.
    // In the header's 82rem container (100rem on big screens), less its padding, so the tree's left edge is the logo's.
    <div data-docs-layout className={cn("mx-auto flex w-full flex-1 xl:max-w-[79rem] xl:gap-8 2xl:max-w-[97rem]", sections ? "max-w-[79rem] gap-8" : "max-w-[71rem] gap-10")}>
      {/* From the header to the bottom of the page; the tree scrolls on its own, under the header. */}
      {column(
        <aside className={cn("-my-10 hidden w-64 shrink-0 md:block", reading && READING_HIDES)}>
          <div className="sticky top-[var(--portal-header-height,0px)] max-h-[calc(100dvh-var(--portal-header-height,0px))] overflow-y-auto py-8 pr-4 [scrollbar-width:thin]">
            {nav}
          </div>
        </aside>
      )}
      {/* An article with sections keeps its measure even without a tree (and in reading mode): never wider lines.
          Only the overview takes the container's width; tree-less search results and short articles keep their cap.
          On big screens, beside the tree, the page is centred between the tree and "On this page" (at the container's
          right edge); a short one keeps the longer one's left edge (46rem, less the 3rem it doesn't use). */}
      <div
        className={cn(
          "mx-auto flex w-full min-w-0 flex-col gap-6",
          sections
            ? cn("max-w-[46rem] xl:[:root:not([data-docs-reading])_&]:ml-0", shown && "2xl:[:root:not([data-docs-reading])_&]:ml-auto")
            : wide
              ? "max-w-[43rem] xl:ml-0 xl:max-w-none"
              : shown
                ? "max-w-[43rem] xl:ml-0 2xl:ml-auto 2xl:max-w-[46rem] 2xl:pr-12"
                : overview
                  ? "max-w-[71rem] xl:max-w-none"
                  : "max-w-[71rem] xl:ml-0",
        )}
      >
        {column(
          <>
            {/* On phones and tablets the tree is in the header's menu; without JavaScript (no menu), above the page. */}
            <PortalMenuPart>{nav}</PortalMenuPart>
            <noscript>
              <details className="rounded-xl border md:hidden">
                <summary className="cursor-pointer px-4 py-2 text-sm font-medium">{browse}</summary>
                <div className="border-t p-2">{nav}</div>
              </details>
            </noscript>
          </>
        )}
        {children}
        <PortalFooter docs />
      </div>
      {(sections || shown) && !wide && (
        <aside aria-hidden={sections ? undefined : true} className={cn("hidden w-52 shrink-0 xl:block", reading && READING_HIDES)}>
          {/* Stays in view as the article scrolls, under the header. */}
          {sections && (
            <div className="sticky top-[calc(var(--portal-header-height,0px)+1.5rem)] flex max-h-[calc(100dvh-var(--portal-header-height,0px)-3rem)] flex-col gap-6 overflow-y-auto">
              <OnThisPage headings={headings} lang={headingsLang} />
            </div>
          )}
        </aside>
      )}
    </div>
  );
}
