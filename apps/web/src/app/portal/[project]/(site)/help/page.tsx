import { prisma } from "@tuti/db";
import Link from "next/link";

import { EmptyState } from "@/components/empty-state";
import { HelpAnswer } from "@/components/help-answer";
import { PageHeader } from "@/components/page-header";
import { Button, buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { helpCenter } from "@/server/help-queries";
import { searchHelp } from "@/server/help-search";
import { MAX_POST_TITLE } from "@/server/operations/create";
import { answersEnabled } from "@/server/operations/help-ask";

export const metadata = { title: "Help center" };

function ArticleLinks({ articles }: { articles: { slug: string; title: string }[] }) {
  return (
    <ul className="flex flex-col gap-1.5">
      {articles.map((article) => (
        <li key={article.slug}>
          <Link href={`/help/${article.slug}`} className="break-words text-primary hover:underline">
            {article.title}
          </Link>
        </li>
      ))}
    </ul>
  );
}

/** Published articles matching `query`, each with the passage that matched. */
async function SearchResults({ projectSlug, query }: { projectSlug: string; query: string }) {
  const project = await prisma.project.findUnique({ where: { slug: projectSlug }, select: { id: true } });
  const results = project ? await searchHelp(project.id, query, 10) : [];
  if (results.length === 0) {
    return (
      <EmptyState
        title={`No articles match “${query}”`}
        description="Try other words, or browse all articles."
        action={
          <Link href="/help" className={buttonVariants({ variant: "outline" })}>
            All articles
          </Link>
        }
      />
    );
  }
  return (
    <ul aria-label="Search results" className="flex flex-col gap-4">
      {results.map((result) => (
        <li key={result.slug} className="flex flex-col gap-0.5">
          <Link href={`/help/${result.slug}`} className="break-words text-primary hover:underline">
            {result.title}
          </Link>
          {result.snippet && <p className="text-sm break-words text-muted-foreground">{result.snippet}</p>}
        </li>
      ))}
    </ul>
  );
}

/** The new-post form on the portal's first board, with the question as the title. */
async function feedbackHref(projectSlug: string, question: string) {
  const board = await prisma.board.findFirst({ where: { project: { slug: projectSlug } }, orderBy: { createdAt: "asc" }, select: { slug: true } });
  return board && `/b/${board.slug}?${new URLSearchParams({ title: question.slice(0, MAX_POST_TITLE) })}`;
}

/** The help center: a search box (`?q=`), then each collection with its published articles, then the articles in no collection. */
export default async function HelpCenterPage(props: PageProps<"/portal/[project]/help">) {
  const [{ project: slug }, { q }] = await Promise.all([props.params, props.searchParams]);
  const query = typeof q === "string" ? q.trim().slice(0, 200) : "";
  const { collections, uncollected } = query ? { collections: [], uncollected: [] } : await helpCenter(slug);
  return (
    <div className="flex flex-col gap-8">
      <PageHeader title="Help center" description="Guides and answers to common questions." />
      {/* A plain GET form: search works without JavaScript. */}
      <form role="search" action="/help" className="flex gap-2">
        <Input type="search" name="q" defaultValue={query} maxLength={200} placeholder="Search articles" aria-label="Search the help center" />
        <Button type="submit">Search</Button>
      </form>
      {query && answersEnabled() && <HelpAnswer key={query} projectSlug={slug} question={query} feedbackHref={await feedbackHref(slug, query)} />}
      {query && <SearchResults projectSlug={slug} query={query} />}
      {!query && collections.length === 0 && uncollected.length === 0 && (
        <EmptyState title="Nothing here yet" description="Articles show up here once they're published." />
      )}
      {collections.map((collection) => (
        <section key={collection.slug} aria-labelledby={`collection-${collection.slug}`} className="flex flex-col gap-2">
          <h2 id={`collection-${collection.slug}`} className="font-heading text-lg font-bold tracking-tight break-words">
            {collection.name}
          </h2>
          {collection.description && <p className="text-sm text-muted-foreground">{collection.description}</p>}
          <ArticleLinks articles={collection.articles} />
        </section>
      ))}
      {uncollected.length > 0 && (
        <section aria-labelledby={collections.length > 0 ? "more-articles" : undefined} className="flex flex-col gap-2">
          {collections.length > 0 && (
            <h2 id="more-articles" className="font-heading text-lg font-bold tracking-tight">
              More articles
            </h2>
          )}
          <ArticleLinks articles={uncollected} />
        </section>
      )}
    </div>
  );
}
