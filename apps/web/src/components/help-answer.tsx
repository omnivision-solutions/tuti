"use client";

import { SparklesIcon, ThumbsDownIcon, ThumbsUpIcon } from "lucide-react";
import Link from "next/link";
import { useState, useTransition } from "react";
import { toast } from "sonner";

import { Button, buttonVariants } from "@/components/ui/button";
import { answerBlocks } from "@/lib/answer-text";
import { askHelp, rateHelpAnswer } from "@/server/help-readers";
import type { HelpAnswer as Answer } from "@/server/operations/help-ask";

/**
 * "Ask AI" above the help center's search results. The AI only answers when the visitor
 * asks (each answer costs a model call; crawlers and link previews of ?q= pages never
 * trigger one). Its answer is shown as plain text with its sources, or "I don't know" with
 * a way to post the question as feedback. In the widget (`widget`), sources open the portal
 * in a new tab, so the answer stays in the panel.
 */
export function HelpAnswer({
  projectSlug,
  question,
  feedbackHref,
  widget = false,
}: {
  projectSlug: string;
  question: string;
  feedbackHref: string | null;
  widget?: boolean;
}) {
  const [answer, setAnswer] = useState<Answer | null>(null);
  const [rated, setRated] = useState(false);
  const [pending, startTransition] = useTransition();

  const ask = () =>
    startTransition(async () => {
      const result = await askHelp(projectSlug, question, widget ? "widget" : "portal");
      if ("error" in result) {
        toast.error(result.error);
        return;
      }
      setAnswer(result);
    });

  const rate = (helpful: boolean) =>
    startTransition(async () => {
      const result = await rateHelpAnswer(projectSlug, answer!.id, helpful);
      if (result.error) {
        toast.error(result.error);
        return;
      }
      setRated(true);
    });

  const askButton = (
    <Button variant="outline" disabled={pending} onClick={ask}>
      <SparklesIcon />
      {pending ? "Asking…" : "Ask AI"}
    </Button>
  );

  return (
    <section aria-label="AI answer" aria-busy={pending} className="flex flex-col gap-3 rounded-xl border p-4">
      {(!answer || answer.status === "failed") && (
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-sm text-muted-foreground">
            {answer ? "The AI couldn't answer just now. Try again, or read the articles below." : "Get a short answer from the help center, written by AI."}
          </p>
          {askButton}
        </div>
      )}
      {answer?.status === "answered" && (
        <>
          <div className="flex flex-col gap-3 break-words">
            {answerBlocks(answer.answer ?? "").map((block, i) =>
              block.type === "paragraph" ? (
                <p key={i}>{block.text}</p>
              ) : block.ordered ? (
                <ol key={i} className="flex list-decimal flex-col gap-1 pl-6">
                  {block.items.map((item, j) => <li key={j}>{item}</li>)}
                </ol>
              ) : (
                <ul key={i} className="flex list-disc flex-col gap-1 pl-6">
                  {block.items.map((item, j) => <li key={j}>{item}</li>)}
                </ul>
              ),
            )}
          </div>
          <div className="flex flex-col gap-1">
            <h2 className="text-sm font-semibold">Sources</h2>
            <ul aria-label="Sources" className="flex flex-col gap-1 text-sm">
              {answer.sources.map((source) => (
                <li key={source.slug}>
                  {/* An AI-only article has no page: named, not linked. */}
                  {source.url === null ? (
                    <span className="break-words">{source.title}</span>
                  ) : (
                    <Link href={`/help/${source.slug}`} target={widget ? "_blank" : undefined} className="break-words text-primary hover:underline">
                      {source.title}
                    </Link>
                  )}
                </li>
              ))}
            </ul>
          </div>
          <div className="flex flex-wrap items-center gap-2 border-t pt-3 text-sm text-muted-foreground">
            {rated ? (
              <p>Thanks for letting us know.</p>
            ) : (
              <>
                <p>Written by AI from the articles above. Was it helpful?</p>
                <Button variant="ghost" size="icon-sm" aria-label="Helpful" disabled={pending} onClick={() => rate(true)}>
                  <ThumbsUpIcon />
                </Button>
                <Button variant="ghost" size="icon-sm" aria-label="Not helpful" disabled={pending} onClick={() => rate(false)}>
                  <ThumbsDownIcon />
                </Button>
              </>
            )}
          </div>
        </>
      )}
      {answer?.status === "no_answer" && (
        <div className="flex flex-col gap-1">
          <p className="font-semibold">I don&apos;t know</p>
          <p className="text-sm text-muted-foreground">Nothing in the help center answers that yet. Post it as feedback so the team sees it.</p>
          {feedbackHref && (
            <Link href={feedbackHref} className={buttonVariants({ variant: "outline", className: "mt-2 self-start" })}>
              Post this as feedback
            </Link>
          )}
        </div>
      )}
    </section>
  );
}
