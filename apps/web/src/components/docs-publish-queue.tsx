"use client";

import { ChevronDownIcon } from "lucide-react";
import Link from "next/link";
import { useEffect, useRef, useState, useTransition } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  AlertDialog,
  AlertDialogTrigger,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogCancel,
  AlertDialogAction,
} from "@/components/ui/alert-dialog";
import { plural } from "@/lib/autopilot-words";
import { publishBatch } from "@/lib/docs-publish-batch";
import { publishArticle, publishArticleChanges } from "@/server/docs";

type ReviewReason = "edits_required" | "changed";

type WaitingArticle = {
  slug: string;
  title: string;
  collection: string;
  saved: string;
  published: boolean;
  savedAt: string;
  reviewRequired: boolean;
  revision?: string;
};

/** Keep the confirmed versions and review decisions while live updates refresh the rows. */
export function DocsPublishQueue({ projectSlug, articles }: { projectSlug: string; articles: WaitingArticle[] }) {
  const [expanded, setExpanded] = useState(false);
  const [open, setOpen] = useState(false);
  const [dialogClosed, setDialogClosed] = useState(true);
  const [pending, start] = useTransition();
  const queue = useRef<HTMLElement>(null);
  const trigger = useRef<HTMLButtonElement | null>(null);
  const [selection, setSelection] = useState<{ articles: WaitingArticle[]; all: boolean; index: number } | null>(null);
  const [needsReview, setNeedsReview] = useState<Map<string, ReviewReason>>(new Map());
  const [failures, setFailures] = useState<Map<string, string>>(new Map());
  const [completion, setCompletion] = useState<{ reviewSlug?: string; published: WaitingArticle[]; index: number } | null>(null);
  const focusedCompletion = useRef<typeof completion>(null);
  const select = (selected: WaitingArticle[], all: boolean, button: HTMLButtonElement) => {
    // A refresh may arrive while confirmation is open. Publish only the versions that opened it.
    setSelection({ articles: selected, all, index: all ? 0 : articles.findIndex((article) => article.slug === selected[0]?.slug) });
    setCompletion(null);
    setDialogClosed(false);
    trigger.current = button;
  };
  useEffect(() => {
    if (!completion || focusedCompletion.current === completion || open || pending || !dialogClosed) return;
    // Successful actions refresh the server list. Wait for that commit and for dialog teardown.
    if (completion.published.some((sent) => articles.some((article) => article.slug === sent.slug && article.revision === sent.revision))) return;
    const links = Array.from(queue.current?.querySelectorAll<HTMLAnchorElement>("[data-queue-article]") ?? []);
    const target = completion.reviewSlug
      ? links.find((link) => link.dataset.queueArticle === completion.reviewSlug)
      : links[completion.index] ?? links[0];
    (target ?? queue.current?.querySelector<HTMLElement>("#waiting-title"))?.focus();
    focusedCompletion.current = completion;
  }, [articles, completion, dialogClosed, open, pending]);
  const publish = () => {
    if (!selection) return;
    start(async () => {
      const { published, failed, unattempted, stopped } = await publishBatch(selection.articles, (article) => article.published
        ? publishArticleChanges(projectSlug, article.slug, article.savedAt, article.revision)
        : publishArticle(projectSlug, article.slug, undefined, article.revision));
      setNeedsReview((previous) => {
        const next = new Map(previous);
        for (const failure of failed) if (failure.code === "edits_required" || failure.code === "changed") next.set(failure.article.slug, failure.code);
        return next;
      });
      setFailures((previous) => {
        const next = new Map(previous);
        for (const failure of failed) if (failure.code !== "edits_required" && failure.code !== "changed") next.set(failure.article.slug, failure.error);
        return next;
      });
      const notices = [...failed, ...(stopped ? [stopped] : []), ...unattempted];
      const reviewSlug = notices[0]?.article.slug;
      if (notices.length) setExpanded(true);
      setCompletion({ reviewSlug, published, index: selection.index });
      setOpen(false);
      const notify = notices.length ? toast.warning : toast.success;
      notify(`Published ${plural(published.length, "article")}`, {
        description: notices.length ? <ul className="space-y-1">{notices.map(({ article, error, code }) => <li key={article.slug}>
          {article.title}: {code === "edits_required" ? "An Autopilot edit needs review first." : code === "changed" ? "Changed since you opened this page. Review before publishing." : error}
          {(code === "edits_required" || code === "changed") && <> <Link className="underline underline-offset-4" href={`/app/${projectSlug}/docs/${article.slug}`}>Review article</Link></>}
        </li>)}</ul> : undefined,
      });
    });
  };
  const publishable = articles.filter((article) => !article.reviewRequired && !needsReview.has(article.slug) && !failures.has(article.slug));
  return (
    <AlertDialog open={open} onOpenChange={(next) => !pending && setOpen(next)} onOpenChangeComplete={(next) => { if (!next) setDialogClosed(true); }}>
      <section ref={queue} aria-labelledby="waiting-title" className="docs-publish-queue [&_li_+_li]:[border-top:1px_solid_color-mix(in_oklch,_var(--border)_70%,_transparent)] [&_li]:min-h-19.5">
        <div className="docs-section-heading flex items-center justify-between gap-2.5 min-h-8 [&_h2]:flex [&_h2]:items-center [&_h2]:gap-2 [&_h2]:[font:600_17px/1.35_var(--font-sans)] [&_h2_small]:text-[13px] [&_h2_small]:text-muted-foreground [&_h2_small]:font-normal max-sm:[&_h2]:text-[16px]">
          <h2 id="waiting-title" tabIndex={-1}>
            Waiting to publish <span className="docs-count rounded-full bg-highlight text-highlight-foreground px-1.75 py-0.5 text-xs">{articles.length}</span>
          </h2>
          {publishable.length > 0 && <AlertDialogTrigger onClick={(event) => select(publishable, true, event.currentTarget)} render={<Button size="sm" />}>Publish all</AlertDialogTrigger>}
        </div>
        <p className="docs-section-description text-[13.5px] text-muted-foreground m-[5px_0_15px] max-sm:max-w-[270px] max-sm:text-[13px]">Readers see the published version until you publish.</p>
        {articles.length === 0 ? (
          <p className="py-4 text-sm text-muted-foreground">Everything is published.</p>
        ) : (
          <ul>
            {articles.slice(0, expanded ? undefined : 3).map((article) => {
              const reason = article.reviewRequired ? "edits_required" : needsReview.get(article.slug);
              const failure = failures.get(article.slug);
              return <li key={article.slug}>
                <div>
                  <Link data-queue-article={article.slug} href={`/app/${projectSlug}/docs/${article.slug}`}>{article.title}</Link>
                  <small>
                    {article.collection} · saved {article.saved}
                  </small>
                  {failure && <small>{failure}</small>}
                </div>
                <Link href={`/app/${projectSlug}/docs/${article.slug}`} className={`docs-review-link text-muted-foreground text-[13px] ${reason || failure ? "" : "max-sm:hidden"}`}>
                  {reason === "edits_required" ? "Review Autopilot edit" : reason === "changed" ? "Review changes" : failure ? "Review article" : "Review"}
                </Link>
                {!reason && !failure && <AlertDialogTrigger onClick={(event) => select([article], false, event.currentTarget)} render={<Button size="sm" variant="outline" />}>Publish</AlertDialogTrigger>}
              </li>;
            })}
          </ul>
        )}
        {articles.length > 3 && (
          <button type="button" className="docs-show-more text-muted-foreground text-[13px] flex items-center gap-1.25 mt-1.5" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>
            <ChevronDownIcon className="size-4" />
            {expanded ? "Show fewer" : `Show ${articles.length - 3} more`}
          </button>
        )}
      </section>
      <AlertDialogContent closeDisabled={pending} finalFocus={() => completion ? false : trigger.current?.isConnected ? trigger.current : queue.current?.querySelector<HTMLElement>("#waiting-title")}>
        <AlertDialogHeader>
          <AlertDialogTitle>{selection?.all ? `Publish ${plural(selection.articles.length, "article")}?` : `Publish “${selection?.articles[0]?.title}”?`}</AlertDialogTitle>
          <AlertDialogDescription>
            The saved versions go live on your help center, with each article&apos;s access settings. Articles with waiting Autopilot edits need a review first.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={pending}>Cancel</AlertDialogCancel>
          <AlertDialogAction disabled={pending} focusableWhenDisabled onClick={publish}>
            {pending ? "Publishing…" : selection?.all ? "Publish all" : "Publish"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
