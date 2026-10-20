import { prisma } from "@tuti/db";
import Link from "next/link";

import { EmptyState } from "@/components/empty-state";
import { HelpAnswer } from "@/components/help-answer";
import { HelpCollections, SectionTabs } from "@/components/help-collections";
import { PageHeader } from "@/components/page-header";
import { Button, buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { helpCenter } from "@/server/help-queries";
import { searchHelp } from "@/server/help-search";
import { MAX_POST_TITLE } from "@/server/operations/create";
import { answersEnabled } from "@/server/operations/help-ask";
import { askAPerson } from "@/server/operations/help-escalate";

export const metadata = { title: "Help center" };

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

/** A section's tab: the first is the help center itself. */
const sectionHref = (sections: { slug: string }[], slug: string) => (sections[0]?.slug === slug ? "/help" : `/help?${new URLSearchParams({ section: slug })}`);

/** The new-post form on the portal's first board, with the question as the title. */
async function feedbackHref(projectSlug: string, question: string) {
  const board = await prisma.board.findFirst({ where: { project: { slug: projectSlug } }, orderBy: { createdAt: "asc" }, select: { slug: true } });
  return board && `/b/${board.slug}?${new URLSearchParams({ title: question.slice(0, MAX_POST_TITLE) })}`;
}

/**
 * The help center: a search box (`?q=`, over every section), then each collection with its published
 * articles, then the articles in no collection. With sections, they're tabs (`?section=`; the first
 * by default, an unknown one too), each with its collections; the first also has the articles in none.
 */
export default async function HelpCenterPage(props: PageProps<"/portal/[project]/help">) {
  const [{ project: slug }, { q, section: sectionParam }] = await Promise.all([props.params, props.searchParams]);
  const query = typeof q === "string" ? q.trim().slice(0, 200) : "";
  const help = query ? { collections: [], uncollected: [], sections: [] } : await helpCenter(slug);
  const section = help.sections.find((s) => s.slug === sectionParam) ?? help.sections[0];
  const { collections, uncollected } = section ?? help;
  return (
    <div className="flex flex-col gap-8">
      <PageHeader title="Help center" description="Guides and answers to common questions." />
      {/* A plain GET form: search works without JavaScript. */}
      <form role="search" action="/help" className="flex gap-2">
        <Input type="search" name="q" defaultValue={query} maxLength={200} placeholder="Search articles" aria-label="Search the help center" />
        <Button type="submit">Search</Button>
      </form>
      {query && answersEnabled() && (
        <HelpAnswer key={query} projectSlug={slug} question={query} feedbackHref={await feedbackHref(slug, query)} askAPerson={await askAPerson(slug)} />
      )}
      {query && <SearchResults projectSlug={slug} query={query} />}
      {section && <SectionTabs sections={help.sections} active={section.slug} href={(s) => sectionHref(help.sections, s)} />}
      {!query && collections.length === 0 && uncollected.length === 0 && (
        <EmptyState title="Nothing here yet" description="Articles show up here once they're published." />
      )}
      <HelpCollections collections={collections} uncollected={uncollected} href={(article) => `/help/${article}`} />
    </div>
  );
}
