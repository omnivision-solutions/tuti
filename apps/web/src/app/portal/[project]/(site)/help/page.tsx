import Link from "next/link";

import { EmptyState } from "@/components/empty-state";
import { PageHeader } from "@/components/page-header";
import { helpCenter } from "@/server/help-queries";

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

/** The help center: each collection with its published articles, then the articles in no collection. */
export default async function HelpCenterPage(props: PageProps<"/portal/[project]/help">) {
  const { project: slug } = await props.params;
  const { collections, uncollected } = await helpCenter(slug);
  return (
    <div className="flex flex-col gap-8">
      <PageHeader title="Help center" description="Guides and answers to common questions." />
      {collections.length === 0 && uncollected.length === 0 && (
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
