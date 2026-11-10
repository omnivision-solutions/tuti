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
    <section aria-labelledby="waiting-title" className="docs-publish-queue">
      <div className="docs-section-heading">
        <h2 id="waiting-title">
          Waiting to publish <span className="docs-count">{articles.length}</span>
        </h2>
        {articles.length > 0 && <Publish projectSlug={projectSlug} articles={articles} all />}
      </div>
      <p className="docs-section-description">Readers see the published version until you publish.</p>
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
              <Link href={`/app/${projectSlug}/docs/${article.slug}`} className="docs-review-link">
                Review
              </Link>
              <Publish projectSlug={projectSlug} articles={[article]} />
            </li>
          ))}
        </ul>
      )}
      {articles.length > 3 && (
        <button type="button" className="docs-show-more" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>
          <ChevronDownIcon className="size-4" />
          {expanded ? "Show fewer" : `Show ${articles.length - 3} more`}
        </button>
      )}
    </section>
  );
}
