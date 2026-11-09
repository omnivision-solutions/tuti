"use client";

import { ChevronRightIcon, FileTextIcon } from "lucide-react";
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

/** Fewer than this, and they aren't much of a list: none. */
const MIN_POPULAR = 3;

/** A tab's most-read articles (popularArticles), when the team shows them (Customize → Docs home) and there are a few. */
export function PopularArticles({ articles }: { articles: { href: string; title: string }[] }) {
  if (!usePortalLook().docsHome.popular || articles.length < MIN_POPULAR) {
    return null;
  }
  return (
    <section aria-labelledby="popular-articles" className="flex flex-col gap-3">
      <h2 id="popular-articles" className="group-label">
        Popular articles
      </h2>
      <ul className="flex flex-col">
        {articles.map((article) => (
          <li key={article.href} className="border-b">
            <Link href={article.href} className="group flex items-center gap-3 py-3 text-[0.9375rem] break-words transition-colors hover:text-primary">
              <FileTextIcon aria-hidden className="size-4 shrink-0 text-muted-foreground group-hover:text-primary" />
              <span className="min-w-0 flex-1">{article.title}</span>
              <ChevronRightIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}
