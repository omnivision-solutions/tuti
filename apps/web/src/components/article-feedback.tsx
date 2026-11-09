"use client";

import { cn } from "cn";
import { ThumbsDownIcon, ThumbsUpIcon } from "lucide-react";
import { useEffect, useId, useState, useTransition } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { answerArticle, countArticleView } from "@/server/docs-readers";

const MAX_COMMENT = 500;

/** Counts a help article's view, once per page (from the browser, so link prefetches and most crawlers don't). */
export function ArticleViewCount({ projectSlug, slug }: { projectSlug: string; slug: string }) {
  useEffect(() => {
    countArticleView(projectSlug, slug).catch(() => {});
  }, [projectSlug, slug]);
  return null;
}

/** "Was this helpful?" at the end of a help article; after a "No", what was missing. */
export function ArticleFeedback({ projectSlug, slug, className }: { projectSlug: string; slug: string; className?: string }) {
  const [step, setStep] = useState<"ask" | "comment" | "thanks">("ask");
  const [comment, setComment] = useState("");
  const [pending, startTransition] = useTransition();
  const commentId = useId();

  const send = (helpful: boolean, text?: string) =>
    startTransition(async () => {
      const result = await answerArticle(projectSlug, slug, helpful, text);
      if (result.error) {
        toast.error(result.error);
        return;
      }
      setStep(helpful || text !== undefined ? "thanks" : "comment");
    });

  return (
    <section aria-label="Was this helpful?" className={cn("flex flex-col gap-3 border-t pt-6", className)}>
      {step === "ask" && (
        <div className="flex flex-wrap items-center gap-3">
          <h2 className="font-sans text-[0.9375rem] font-semibold">Was this helpful?</h2>
          <div className="flex gap-2">
            <Button variant="outline" size="sm" disabled={pending} onClick={() => send(true)} className="font-semibold">
              <ThumbsUpIcon aria-hidden />
              Yes
            </Button>
            <Button variant="outline" size="sm" disabled={pending} onClick={() => send(false)} className="font-semibold">
              <ThumbsDownIcon aria-hidden />
              No
            </Button>
          </div>
        </div>
      )}
      {step === "comment" && (
        <form
          className="flex flex-col gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            send(false, comment);
          }}
        >
          <Label htmlFor={commentId}>What were you looking for? (optional)</Label>
          <Textarea
            id={commentId}
            value={comment}
            maxLength={MAX_COMMENT}
            onChange={(event) => setComment(event.target.value)}
          />
          <div className="flex justify-end">
            <Button type="submit" disabled={pending || !comment.trim()}>
              Send
            </Button>
          </div>
        </form>
      )}
      {step === "thanks" && <p className="text-sm text-muted-foreground">Thanks for letting us know.</p>}
    </section>
  );
}
