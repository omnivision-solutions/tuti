"use client";

import Link from "next/link";

import { PageHeader } from "@/components/page-header";
import { usePortalLook } from "@/components/portal-look";

/** The docs' default heading and the line under it, where the team hasn't set its own (Customize → Docs home). */
export const DOCS_HEADING = { title: "Docs", subtitle: "Guides and answers to common questions." };

/** The docs' home's heading: the team's title and subtitle (Customize → Docs home), or the defaults. */
export function DocsHomeHeader() {
  const { docsHome } = usePortalLook();
  return <PageHeader title={docsHome.title || DOCS_HEADING.title} description={docsHome.subtitle || DOCS_HEADING.subtitle} />;
}

/** The docs' home's most-read articles (popularArticles), when the team shows them (Customize → Docs home). */
export function PopularArticles({ articles }: { articles: { href: string; title: string }[] }) {
  if (!usePortalLook().docsHome.popular || articles.length === 0) {
    return null;
  }
  return (
    <section aria-labelledby="popular-articles" className="flex flex-col gap-2">
      <h2 id="popular-articles" className="font-heading text-lg font-bold tracking-tight">
        Popular articles
      </h2>
      <ul className="flex flex-col divide-y rounded-xl border">
        {articles.map((article) => (
          <li key={article.href}>
            <Link href={article.href} className="block px-4 py-3 text-sm break-words transition-colors hover:bg-accent/50">
              {article.title}
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}
