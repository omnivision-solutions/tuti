"use client";

import { MessageCircleIcon, SparklesIcon, ThumbsDownIcon, ThumbsUpIcon } from "lucide-react";
import Link from "next/link";
import { type FormEvent, useId, useState, useTransition } from "react";
import { toast } from "sonner";

import { Button, buttonVariants } from "@/components/ui/button";
import { Field, FieldError, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { useWidgetSignIn } from "@/components/widget-feedback";
import { answerBlocks } from "@/lib/answer-text";
import { askDocs, escalateDocs, rateDocsAnswer } from "@/server/docs-readers";
import type { DocsAnswer as Answer } from "@/server/operations/docs-ask";
import { useDocsAssistant } from "@/components/docs-assistant-context";
import { usePortalHref } from "@/components/portal-base";

/**
 * "Ask AI" above the docs' search results. The AI only answers when the visitor
 * asks (each answer costs a model call; crawlers and link previews of ?q= pages never
 * trigger one). Its answer is shown as plain text with its sources, or "I don't know" with
 * a way to post the question as feedback. When the team has a support email (`askAPerson`,
 * with the address to start with), "I don't know" and a thumbs-down also offer "Ask a person".
 * In the widget (`widget`), sources open the portal in a new tab, so the answer stays in the panel.
 */
export function DocsAnswer({
  projectSlug,
  question,
  feedbackHref,
  askAPerson,
  widget = false,
}: {
  projectSlug: string;
  question: string;
  feedbackHref: string | null;
  askAPerson: { email: string } | null;
  widget?: boolean;
}) {
  const assistant = useDocsAssistant();
  const [answer, setAnswer] = useState<Answer | null>(null);
  const [rated, setRated] = useState<boolean | null>(null);
  const [pending, startTransition] = useTransition();

  const ask = () =>
    startTransition(async () => {
      const result = await askDocs(projectSlug, question, widget ? "widget" : "portal");
      if ("error" in result) {
        toast.error(result.error);
        return;
      }
      setAnswer(result);
    });

  const rate = (helpful: boolean) =>
    startTransition(async () => {
      const result = await rateDocsAnswer(projectSlug, answer!.id, helpful);
      if (result.error) {
        toast.error(result.error);
        return;
      }
      setRated(helpful);
    });

  const person = askAPerson && answer && (
    <AskAPerson projectSlug={projectSlug} questionId={answer.id} defaultEmail={askAPerson.email} widget={widget} />
  );

  // On the portal, the conversation can go on in the assistant (the widget has none).
  const followUp = !widget && assistant && answer && (
    <div>
      <Button variant="outline" size="sm" onClick={() => assistant.continueWith(question, answer)}>
        <MessageCircleIcon />
        Ask a follow-up
      </Button>
    </div>
  );

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
            {answer ? "The AI couldn't answer just now. Try again, or read the articles below." : "Get a short answer from the docs, written by AI."}
          </p>
          {askButton}
        </div>
      )}
      {answer?.status === "answered" && (
        <>
          <AnswerText text={answer.answer ?? ""} />
          <AnswerSources sources={answer.sources} newTab={widget} />
          <div className="flex flex-wrap items-center gap-2 border-t pt-3 text-sm text-muted-foreground">
            {rated !== null ? (
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
            {rated === false && person}
          </div>
          {followUp}
        </>
      )}
      {(answer?.status === "no_answer" || answer?.status === "off_limits") && (
        <div className="flex flex-col gap-1">
          {answer.status === "no_answer" ? (
            <>
              <p className="font-semibold">I don&apos;t know</p>
              <p className="text-sm text-muted-foreground">Nothing in the docs answers that yet. Post it as feedback so the team sees it.</p>
            </>
          ) : (
            // A topic the team put off-limits: a fixed reply, the AI wasn't asked.
            <>
              <p className="font-semibold">I can&apos;t help with that here.</p>
              <p className="text-sm text-muted-foreground">Post it as feedback so the team sees it.</p>
            </>
          )}
          <div className="mt-2 flex flex-wrap items-center gap-2">
            {feedbackHref && (
              <Link href={feedbackHref} className={buttonVariants({ variant: "outline" })}>
                Post this as feedback
              </Link>
            )}
            {person}
          </div>
          {followUp}
        </div>
      )}
    </section>
  );
}

/** An AI answer's text: paragraphs and lists (lib/answer-text.ts), plain text only. */
export function AnswerText({ text }: { text: string }) {
  return (
    <div className="flex flex-col gap-3 break-words">
      {answerBlocks(text).map((block, i) =>
        block.type === "paragraph" ? (
          <p key={i}>{block.text}</p>
        ) : block.ordered ? (
          <ol key={i} className="flex list-decimal flex-col gap-1 pl-6">
            {block.items.map((item, j) => (
              <li key={j}>{item}</li>
            ))}
          </ol>
        ) : (
          <ul key={i} className="flex list-disc flex-col gap-1 pl-6">
            {block.items.map((item, j) => (
              <li key={j}>{item}</li>
            ))}
          </ul>
        ),
      )}
    </div>
  );
}

/** The articles an answer cites, linked (an AI-only one, which has no page, by name). `newTab` in the widget; `onOpen` when one is opened. */
export function AnswerSources({ sources, newTab = false, onOpen }: { sources: Answer["sources"]; newTab?: boolean; onOpen?: () => void }) {
  const at = usePortalHref();
  return (
    <div className="flex flex-col gap-1">
      <h2 className="text-sm font-semibold">Sources</h2>
      <ul aria-label="Sources" className="flex flex-col gap-1 text-sm">
        {sources.map((source) => (
          <li key={source.slug}>
            {source.url === null ? (
              <span className="break-words">{source.title}</span>
            ) : (
              <Link href={at(`/docs/${source.slug}`)} target={newTab ? "_blank" : undefined} onClick={onOpen} className="break-words text-primary hover:underline">
                {source.title}
              </Link>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * "Ask a person": the visitor's email (prefilled when we know it: their account, or in the widget
 * the email the customer's page signs them in with) and an optional note, then the question goes to
 * the team by email (docs.escalate). Opens in place, taking the row's width.
 */
export function AskAPerson({ projectSlug, questionId, defaultEmail, widget }: { projectSlug: string; questionId: string; defaultEmail: string; widget: boolean }) {
  const [open, setOpen] = useState(false);
  const [sentTo, setSentTo] = useState<string | null>(null);
  /** The email as the visitor typed it; null until they type. */
  const [typed, setTyped] = useState<string | null>(null);
  const [error, setError] = useState<string>();
  const [pending, startTransition] = useTransition();
  // In the widget on a customer's site, the page may sign its visitor in: start with their email.
  const { signedIn } = useWidgetSignIn(projectSlug, widget && open && !defaultEmail);
  const id = useId();

  const send = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const email = String(form.get("email") ?? "");
    startTransition(async () => {
      const result = await escalateDocs(projectSlug, questionId, email, String(form.get("note") ?? ""), widget ? "widget" : "portal");
      if (result.error) {
        setError(result.error);
        return;
      }
      setSentTo(email.trim().toLowerCase());
    });
  };

  if (sentTo) {
    return (
      <div role="status" className="flex w-full flex-col gap-1 text-foreground">
        <p className="font-semibold">We&apos;ve passed this to the team; they&apos;ll reply by email.</p>
        <p className="text-sm break-words text-muted-foreground">A copy of what we sent is on its way to {sentTo}.</p>
      </div>
    );
  }
  if (!open) {
    return (
      <Button variant="outline" onClick={() => setOpen(true)}>
        Ask a person
      </Button>
    );
  }
  return (
    <form aria-label="Ask a person" onSubmit={send} className="flex w-full flex-col gap-3 rounded-lg border p-3 text-foreground">
      <p className="text-sm text-muted-foreground">We&apos;ll email your question and the AI&apos;s answer to the team. They&apos;ll reply to you by email.</p>
      <Field>
        <FieldLabel htmlFor={`${id}-email`}>Your email</FieldLabel>
        <Input
          id={`${id}-email`}
          name="email"
          type="email"
          required
          maxLength={320}
          autoComplete="email"
          // What they typed wins; until they type, the widget's signed-in email fills it in when it arrives.
          value={typed ?? (defaultEmail || signedIn?.email || "")}
          onChange={(event) => setTyped(event.target.value)}
        />
      </Field>
      <Field>
        <FieldLabel htmlFor={`${id}-note`}>Anything to add? (optional)</FieldLabel>
        <Textarea id={`${id}-note`} name="note" maxLength={1000} rows={3} />
      </Field>
      {error && <FieldError>{error}</FieldError>}
      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
          Cancel
        </Button>
        <Button type="submit" disabled={pending}>
          {pending ? "Sending…" : "Send to the team"}
        </Button>
      </div>
    </form>
  );
}
