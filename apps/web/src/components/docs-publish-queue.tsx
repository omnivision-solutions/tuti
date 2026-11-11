"use client";

import { ChevronDownIcon } from "lucide-react";
import Link from "next/link";
import { useRef, useState, useTransition } from "react";
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
import { publishArticle, publishArticleChanges } from "@/server/docs";

type WaitingArticle = {
  slug: string;
  title: string;
  collection: string;
  saved: string;
  published: boolean;
  savedAt: string;
  reviewRequired: boolean;
};

/** Publishes the saved versions shown here, stopping on a stale version rather than taking unseen changes live. */
function Publish({ projectSlug, articles, all = false, hidden = false, onReviewRequired, returnFocus }: {
  projectSlug: string;
  articles: WaitingArticle[];
  all?: boolean;
  hidden?: boolean;
  onReviewRequired: (slug: string) => void;
  returnFocus: (slug?: string) => HTMLElement | null;
}) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const reviewTarget = useRef<string | undefined>(undefined);
  const [pending, start] = useTransition();
  return (
    <AlertDialog open={open} onOpenChange={(next) => !pending && setOpen(next)}>
      {!hidden && <AlertDialogTrigger ref={trigger} onClick={() => { reviewTarget.current = undefined; }} render={<Button size="sm" variant={all ? "default" : "outline"} />}>{all ? "Publish all" : "Publish"}</AlertDialogTrigger>}
      <AlertDialogContent closeDisabled={pending} finalFocus={() => {
        if (reviewTarget.current) return returnFocus(reviewTarget.current);
        return trigger.current?.isConnected ? trigger.current : returnFocus();
      }}>
        <AlertDialogHeader>
          <AlertDialogTitle>{all ? `Publish ${plural(articles.length, "article")}?` : `Publish “${articles[0]?.title}”?`}</AlertDialogTitle>
          <AlertDialogDescription>
            The saved versions go live on your help center, with each article&apos;s access settings. Articles with waiting Autopilot edits need a review first.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={pending}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            disabled={pending}
            onClick={() =>
              start(async () => {
                let published = 0;
                for (const article of articles) {
                  const result = article.published
                    ? await publishArticleChanges(projectSlug, article.slug, article.savedAt)
                    : await publishArticle(projectSlug, article.slug);
                  if (result.error && "code" in result && (result.code === "edits_required" || result.code === "changed")) {
                    toast.error(result.code === "changed" ? `${article.title} has changed since you opened this page. Review it before publishing.` : `${article.title} has an Autopilot edit to review first`, {
                      description: <Link className="underline underline-offset-4" href={`/app/${projectSlug}/docs/${article.slug}`}>Review article</Link>,
                    });
                    reviewTarget.current ??= article.slug;
                    onReviewRequired(article.slug);
                    continue;
                  }
                  if (result.error) {
                    toast.error(result.error);
                    return;
                  }
                  published++;
                }
                setOpen(false);
                if (published > 0) toast.success(all ? "Articles published" : "Published");
              })
            }
          >
            {pending ? "Publishing…" : all ? "Publish all" : "Publish"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

export function DocsPublishQueue({ projectSlug, articles }: { projectSlug: string; articles: WaitingArticle[] }) {
  const [expanded, setExpanded] = useState(false);
  const queue = useRef<HTMLElement>(null);
  const returnFocus = (slug?: string) =>
    (slug ? Array.from(queue.current?.querySelectorAll<HTMLAnchorElement>("[data-queue-article]") ?? []).find((link) => link.dataset.queueArticle === slug) : null)
    ?? queue.current?.querySelector<HTMLElement>("#waiting-title") ?? null;
  const [needsReview, setNeedsReview] = useState<Set<string>>(new Set());
  const onReviewRequired = (slug: string) => setNeedsReview((previous) => new Set(previous).add(slug));
  const publishable = articles.filter((article) => !article.reviewRequired && !needsReview.has(article.slug));
  return (
    <section ref={queue} aria-labelledby="waiting-title" className="docs-publish-queue [&_li_+_li]:[border-top:1px_solid_color-mix(in_oklch,_var(--border)_70%,_transparent)] [&_li]:min-h-19.5">
      <div className="docs-section-heading flex items-center justify-between gap-2.5 min-h-8 [&_h2]:flex [&_h2]:items-center [&_h2]:gap-2 [&_h2]:[font:600_17px/1.35_var(--font-sans)] [&_h2_small]:text-[13px] [&_h2_small]:text-muted-foreground [&_h2_small]:font-normal max-sm:[&_h2]:text-[16px]">
        <h2 id="waiting-title" tabIndex={-1}>
          Waiting to publish <span className="docs-count rounded-[30px] bg-highlight text-highlight-foreground p-[2px_7px] text-xs">{articles.length}</span>
        </h2>
        <Publish projectSlug={projectSlug} articles={publishable} all hidden={publishable.length === 0} onReviewRequired={onReviewRequired} returnFocus={returnFocus} />
      </div>
      <p className="docs-section-description text-[13.5px] text-muted-foreground m-[5px_0_15px] max-sm:max-w-[270px] max-sm:text-[13px]">Readers see the published version until you publish.</p>
      {articles.length === 0 ? (
        <p className="py-4 text-sm text-muted-foreground">Everything is published.</p>
      ) : (
        <ul>
          {articles.slice(0, expanded ? undefined : 3).map((article) => (
            <li key={article.slug}>
              <div>
                <Link data-queue-article={article.slug} href={`/app/${projectSlug}/docs/${article.slug}`}>{article.title}</Link>
                <small>
                  {article.collection} · saved {article.saved}
                </small>
              </div>
              <Link href={`/app/${projectSlug}/docs/${article.slug}`} className={`docs-review-link text-muted-foreground text-[13px] ${article.reviewRequired || needsReview.has(article.slug) ? "" : "max-sm:hidden"}`}>
                {article.reviewRequired || needsReview.has(article.slug) ? "Review Autopilot edit" : "Review"}
              </Link>
              <Publish projectSlug={projectSlug} articles={[article]} hidden={article.reviewRequired || needsReview.has(article.slug)} onReviewRequired={onReviewRequired} returnFocus={returnFocus} />
            </li>
          ))}
        </ul>
      )}
      {articles.length > 3 && (
        <button type="button" className="docs-show-more text-muted-foreground text-[13px] flex items-center gap-1.25 mt-1.5" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>
          <ChevronDownIcon className="size-4" />
          {expanded ? "Show fewer" : `Show ${articles.length - 3} more`}
        </button>
      )}
    </section>
  );
}
