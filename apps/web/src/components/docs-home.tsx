"use client";

import { FileTextIcon, TrendingUpIcon } from "lucide-react";
import Link from "next/link";

import { usePortalLook } from "@/components/portal-look";

/** The docs' default heading and the line under it, where the team hasn't set its own (Customize → Docs home). */
export const DOCS_HEADING = { title: "How can we help?", subtitle: "Guides and answers to common questions." };

/** The docs' home's heading, centred over its search: the team's title and subtitle (Customize → Docs home), or the defaults. */
export function DocsHomeHeader() {
  const { docsHome } = usePortalLook();
  return (
    <div className="flex flex-col items-center gap-3 text-center">
      <h1 className="font-heading text-[2.25rem] leading-[1.05] font-[650] tracking-[-0.03em] break-words sm:text-[3.5rem]">
        {docsHome.title || DOCS_HEADING.title}
      </h1>
      <p className="text-base text-muted-foreground sm:text-lg">{docsHome.subtitle || DOCS_HEADING.subtitle}</p>
    </div>
  );
}

/** Fewer than this, and they aren't much of a list: none. */
const MIN_POPULAR = 3;

/** Whether the docs' home shows its popular articles (the team shows them, Customize → Docs home, and there are a few). */
export function useShowsPopular(articles: unknown[]) {
  return usePortalLook().docsHome.popular && articles.length >= MIN_POPULAR;
}

/** The most-read of them as chips under the home's search (as the popular articles are shown). */
export function PopularChips({ articles }: { articles: { href: string; title: string }[] }) {
  if (!useShowsPopular(articles)) {
    return null;
  }
  return (
    // One row; on phones it scrolls sideways.
    <ul aria-label="Suggested articles" className="-mx-4 flex max-w-[calc(100%+2rem)] gap-2 overflow-x-auto px-4 [scrollbar-width:none] sm:mx-0 sm:max-w-full sm:flex-wrap sm:justify-center sm:px-0">
      {articles.slice(0, 3).map((article) => (
        <li key={article.href}>
          <Link
            href={article.href}
            className="inline-flex h-9 items-center rounded-full border whitespace-nowrap border-input bg-background px-3.5 text-[0.9375rem] text-muted-foreground transition-colors hover:border-primary/40 hover:text-foreground"
          >
            {article.title}
          </Link>
        </li>
      ))}
    </ul>
  );
}

/** A tab's most-read articles (popularArticles), when the team shows them (Customize → Docs home) and there are a few: a card, in two columns. */
export function PopularArticles({ articles }: { articles: { href: string; title: string }[] }) {
  if (!useShowsPopular(articles)) {
    return null;
  }
  return (
    <section aria-labelledby="popular-articles" className="flex flex-col rounded-xl bg-card px-2.5 pt-1 pb-2.5 shadow-card ring-1 ring-card-edge">
      <h2 id="popular-articles" className="flex items-center gap-2 border-b px-3 py-4 font-sans text-base font-semibold">
        <TrendingUpIcon aria-hidden className="size-4 text-primary" />
        Popular articles
      </h2>
      <ul className="grid pt-1.5 sm:grid-cols-2">
        {articles.map((article) => (
          <li key={article.href}>
            <Link
              href={article.href}
              className="group flex items-center gap-3 rounded-lg px-3 py-2.5 text-[0.9375rem] font-medium break-words transition-colors hover:bg-accent"
            >
              <FileTextIcon aria-hidden className="size-4 shrink-0 text-muted-foreground group-hover:text-primary" />
              <span className="min-w-0 flex-1">{article.title}</span>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}
