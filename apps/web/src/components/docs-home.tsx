"use client";

import { ChevronRightIcon, FileTextIcon } from "lucide-react";
import Link from "next/link";
import { useTranslations } from "next-intl";

import { usePortalLook, useTeamLanguage } from "@/components/portal-look";

/**
 * The docs' home's heading, centred over its search: the team's title and subtitle (Customize → Docs home, in their
 * language), or the defaults (the portal's, in the page's).
 */
export function DocsHomeHeader() {
  const { docsHome } = usePortalLook();
  const t = useTranslations("helpCenter");
  const team = useTeamLanguage();
  return (
    <div className="flex flex-col items-center gap-3 text-center">
      <h1 lang={docsHome.title ? team : undefined} className="font-heading text-[2.25rem] leading-[1.05] font-[650] tracking-[-0.03em] break-words sm:text-[3.5rem]">
        {docsHome.title || t("headingTitle")}
      </h1>
      <p lang={docsHome.subtitle ? team : undefined} className="text-base text-muted-foreground sm:text-lg">
        {docsHome.subtitle || t("headingSubtitle")}
      </p>
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
  // The titles: the team's words (useTeamLanguage).
  const lang = useTeamLanguage();
  const t = useTranslations("helpCenter");
  if (!useShowsPopular(articles)) {
    return null;
  }
  return (
    // One row; on phones it scrolls sideways.
    <ul aria-label={t("suggested")} className="-mx-4 flex max-w-[calc(100%+2rem)] gap-2 overflow-x-auto px-4 [scrollbar-width:none] sm:mx-0 sm:max-w-full sm:flex-wrap sm:justify-center sm:px-0">
      {articles.slice(0, 3).map((article) => (
        <li key={article.href}>
          <Link
            href={article.href}
            lang={lang}
            className="inline-flex h-9 items-center rounded-full bg-secondary px-3.5 text-[0.9375rem] whitespace-nowrap text-muted-foreground transition-colors hover:bg-secondary-hover hover:text-foreground"
          >
            {article.title}
          </Link>
        </li>
      ))}
    </ul>
  );
}

/** A tab's most-read articles (popularArticles), when the team shows them (Customize → Docs home) and there are a few: rows on the paper, in two columns. */
export function PopularArticles({ articles }: { articles: { href: string; title: string }[] }) {
  // The titles: the team's words (useTeamLanguage).
  const lang = useTeamLanguage();
  const t = useTranslations("helpCenter");
  if (!useShowsPopular(articles)) {
    return null;
  }
  return (
    <section aria-labelledby="popular-articles" className="flex flex-col gap-3">
      <h2 id="popular-articles" className="font-sans text-[0.8125rem] font-medium text-muted-foreground">
        {t("popular")}
      </h2>
      <ul className="grid sm:grid-cols-2 sm:gap-x-10">
        {articles.map((article) => (
          <li key={article.href} className="border-b">
            <Link href={article.href} className="group flex items-center gap-3 py-3 text-[0.9375rem] break-words transition-colors hover:text-primary">
              <FileTextIcon aria-hidden className="size-4 shrink-0 text-muted-foreground group-hover:text-primary" />
              <span lang={lang} className="min-w-0 flex-1">{article.title}</span>
              <ChevronRightIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}
