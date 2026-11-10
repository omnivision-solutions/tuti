"use client";

import { ChevronDownIcon } from "lucide-react";
import Link from "next/link";
import { useState, useTransition } from "react";
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
import { publishArticle, publishArticleChanges } from "@/server/docs";

type WaitingArticle = {
  slug: string;
  title: string;
  collection: string;
  saved: string;
  published: boolean;
  savedAt: string;
  edits: string[];
};

/** Publishes the saved versions shown here, stopping on a stale version rather than taking unseen changes live. */
function Publish({ projectSlug, articles, all = false }: { projectSlug: string; articles: WaitingArticle[]; all?: boolean }) {
  const [open, setOpen] = useState(false);
  const [pending, start] = useTransition();
  return (
    <AlertDialog open={open} onOpenChange={(next) => !pending && setOpen(next)}>
      <AlertDialogTrigger render={<Button size="sm" variant={all ? "default" : "outline"} />}>{all ? "Publish all" : "Publish"}</AlertDialogTrigger>
      <AlertDialogContent closeDisabled={pending}>
        <AlertDialogHeader>
          <AlertDialogTitle>{all ? `Publish ${articles.length} articles?` : `Publish “${articles[0]?.title}”?`}</AlertDialogTitle>
          <AlertDialogDescription>
            The saved versions go live on your help center, with each article&apos;s access settings. Any edits Autopilot suggested in these drafts go
            live too.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={pending}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            disabled={pending}
            onClick={() =>
              start(async () => {
                for (const article of articles) {
                  const result = article.published
                    ? await publishArticleChanges(projectSlug, article.slug, article.savedAt)
                    : await publishArticle(projectSlug, article.slug, article.edits);
                  if (result.error) {
                    toast.error(result.error);
                    return;
                  }
                }
                setOpen(false);
                toast.success(all ? "Articles published" : "Published");
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
  return (
    <section aria-labelledby="waiting-title" className="docs-publish-queue [&_li_+_li]:[border-top:1px_solid_color-mix(in_oklch,_var(--border)_70%,_transparent)] [&_li]:min-h-19.5">
      <div className="docs-section-heading flex items-center justify-between gap-2.5 min-h-8 [&_h2]:flex [&_h2]:items-center [&_h2]:gap-2 [&_h2]:[font:600_17px/1.35_var(--font-sans)] [&_h2_small]:text-[13px] [&_h2_small]:text-muted-foreground [&_h2_small]:font-normal max-sm:[&_h2]:text-[16px]">
        <h2 id="waiting-title">
          Waiting to publish <span className="docs-count rounded-[30px] bg-highlight text-highlight-foreground p-[2px_7px] text-[12px]">{articles.length}</span>
        </h2>
        {articles.length > 0 && <Publish projectSlug={projectSlug} articles={articles} all />}
      </div>
      <p className="docs-section-description text-[13.5px] text-muted-foreground m-[5px_0_15px] max-sm:max-w-[270px] max-sm:text-[13px]">Readers see the published version until you publish.</p>
      {articles.length === 0 ? (
        <p className="py-4 text-sm text-muted-foreground">Everything is published.</p>
      ) : (
        <ul>
          {articles.slice(0, expanded ? undefined : 3).map((article) => (
            <li key={article.slug}>
              <div>
                <Link href={`/app/${projectSlug}/docs/${article.slug}`}>{article.title}</Link>
                <small>
                  {article.collection} · saved {article.saved}
                </small>
              </div>
              <Link href={`/app/${projectSlug}/docs/${article.slug}`} className="docs-review-link text-muted-foreground text-[13px] max-sm:hidden">
                Review
              </Link>
              <Publish projectSlug={projectSlug} articles={[article]} />
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
