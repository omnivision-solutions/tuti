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
import { useVisitor, visitorStore } from "@/components/widget-messages";
import { answerBlocks } from "@/lib/answer-text";
import { askDocs, escalateDocs, rateDocsAnswer } from "@/server/docs-readers";
import { widgetStartConversation } from "@/server/widget-inbox";
import type { DocsAnswer as Answer } from "@/server/operations/docs-ask";
import { askedFrom, useDocsAssistant } from "@/components/docs-assistant-context";
import { usePortalHref } from "@/components/portal-base";

/**
 * "Ask AI" above the docs' search results. The AI only answers when the visitor
 * asks (each answer costs a model call; crawlers and link previews of ?q= pages never
 * trigger one). Its answer is shown as plain text with its sources, or "I don't know" with
 * a way to post the question as feedback. When the team takes questions in its inbox (`askAPerson`,
 * with the address to start with), "I don't know" and a thumbs-down also offer "Ask a person".
 */
export function DocsAnswer({
  projectSlug,
  question,
  feedbackHref,
  askAPerson,
}: {
  projectSlug: string;
  question: string;
  feedbackHref: string | null;
  askAPerson: { email: string } | null;
}) {
  const assistant = useDocsAssistant();
  const [answer, setAnswer] = useState<Answer | null>(null);
  const [rated, setRated] = useState<boolean | null>(null);
  const [pending, startTransition] = useTransition();

  const ask = () =>
    startTransition(async () => {
      const result = await askDocs(projectSlug, question, "portal");
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
    <AskAPerson projectSlug={projectSlug} questionId={answer.id} question={question} defaultEmail={askAPerson.email} widget={false} />
  );

  // The conversation can go on in the widget's assistant, from this answer.
  const followUp = assistant && answer && (
    <div>
      <Button variant="outline" size="sm" onClick={() => assistant.continueWith(question, answer)}>
        <MessageCircleIcon />
        Ask a follow-up
      </Button>
    </div>
  );

  const askButton = (
    // The portal's search page's one filled primary.
    <Button disabled={pending} onClick={ask}>
      <SparklesIcon />
      {pending ? "Asking…" : "Ask AI"}
    </Button>
  );

  return (
    <section aria-label="AI answer" aria-busy={pending} className={"flex flex-col gap-3 rounded-xl bg-card p-4 shadow-card ring-1 ring-card-edge"}>
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
          <AnswerSources sources={answer.sources} />
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
      {(answer?.status === "no_answer" || answer?.status === "off_limits" || answer?.status === "unavailable") && (
        <div className="flex flex-col gap-1">
          {answer.status === "no_answer" ? (
            <>
              <p className="font-semibold">I don&apos;t know</p>
              <p className="text-sm text-muted-foreground">Nothing in the docs answers that yet. Post it as feedback so the team sees it.</p>
            </>
          ) : answer.status === "unavailable" ? (
            // The project's AI is paused (out of AI credits): the AI wasn't asked; the closest articles instead.
            <>
              <p className="font-semibold">AI answers aren&apos;t available right now.</p>
              <p className="text-sm text-muted-foreground">These articles may help. Or post it as feedback so the team sees it.</p>
              {answer.sources.length > 0 && <AnswerSources sources={answer.sources} />}
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

/**
 * The articles an answer cites, linked (an AI-only one, which has no page, by name): to their pages, or
 * `href` (the widget's own article view); `onOpen` when one is opened.
 */
export function AnswerSources({
  sources,
  href,
  onOpen,
}: {
  sources: Answer["sources"];
  href?: (slug: string) => string;
  onOpen?: () => void;
}) {
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
              <Link
                href={href ? href(source.slug) : at(`/docs/${source.slug}`)}
                onClick={onOpen}
                className="break-words text-primary hover:underline"
              >
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
 * the email the customer's page signs them in with) and an optional note, then the question starts a
 * conversation in the team's inbox (docs.escalate), whose reply shows in Messages. Opens in place, taking the row's width.
 * Without `questionId` (in the widget, when asking the AI failed: nothing was recorded), the question and their note start
 * the conversation as a message of theirs, as Messages would.
 */
export function AskAPerson({
  projectSlug,
  questionId,
  question,
  defaultEmail,
  widget,
  sent: sentBefore,
  onSent,
  onLeave,
}: {
  projectSlug: string;
  questionId: string | null;
  question: string;
  defaultEmail: string;
  widget: boolean;
  /** Passed to the team already (the assistant keeps that with the turn): it says so, and doesn't offer it again. */
  sent?: boolean;
  onSent?: () => void;
  /** Closes the assistant around it when "Open Messages" leaves for the Messages tab. */
  onLeave?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [sentHere, setSent] = useState(false);
  const sent = sentHere || !!sentBefore;
  /** The email as the visitor typed it; null until they type. */
  const [typed, setTyped] = useState<string | null>(null);
  const [error, setError] = useState<string>();
  const [pending, startTransition] = useTransition();
  // In the widget on a customer's site, the page may sign its visitor in: start with their email, and
  // it's their conversation (else a visitor's, the one they had or a new one).
  const { signedIn, known } = useWidgetSignIn(projectSlug, widget && open);
  // Whose conversation it starts depends on who the page signs in: wait for its answer.
  const waiting = widget && !known;
  const visitor = useVisitor(projectSlug);
  const signedInEmail = signedIn ? (signedIn.email ?? "") : defaultEmail;
  const at = usePortalHref();
  const id = useId();

  const send = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const email = String(form.get("email") ?? "");
    startTransition(async () => {
      const who = { token: signedIn?.token ?? null, visitor: signedIn ? null : (visitor?.token ?? null) };
      const note = String(form.get("note") ?? "");
      const result = questionId
        ? await escalateDocs(projectSlug, questionId, email, note, widget ? askedFrom() : "portal", who)
        : await widgetStartConversation(projectSlug, who, [question, note.trim()].filter(Boolean).join("\n\n"), signedIn ? undefined : email);
      if ("error" in result && result.error) {
        setError(result.error);
        return;
      }
      const visitorToken = "visitor" in result ? result.visitor : undefined;
      if (visitorToken) {
        visitorStore.write(projectSlug, { token: visitorToken, email: email.trim() });
      }
      setSent(true);
      onSent?.();
    });
  };

  if (sent) {
    const button = buttonVariants({ variant: "outline", size: "sm" });
    return (
      <div role="status" className="flex w-full flex-col items-start gap-2 text-foreground">
        <p className="font-semibold">We&apos;ve passed this to the team. Their reply will show in Messages.</p>
        {widget ? (
          <Link href={at("/widget?tab=messages")} onClick={onLeave} className={button}>
            Open Messages
          </Link>
        ) : (
          // The portal's Messages are the widget's, on a page of their own (as "Contact us" opens them).
          <a href={at("/widget?tab=messages")} target="_blank" rel="noopener" className={button}>
            Open Messages
          </a>
        )}
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
      <p className="text-sm text-muted-foreground">
        {/* Without a recorded question (asking failed), there's no answer of the AI's to pass on. */}
        {questionId ? "We'll pass your question and the AI's answer to the team." : "We'll pass your question to the team."} They&apos;ll reply in Messages.
      </p>
      <Field>
        <FieldLabel htmlFor={`${id}-email`}>Your email</FieldLabel>
        <Input
          id={`${id}-email`}
          name="email"
          type="email"
          required
          maxLength={320}
          autoComplete="email"
          // Someone signed in (by the page, else on the portal) gets their own conversation, so their address is shown, not asked for.
          // Else the one they gave in Messages before, if any.
          value={signedInEmail || (typed ?? visitor?.email ?? "")}
          readOnly={!!signedInEmail}
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
        <Button type="submit" disabled={pending || waiting}>
          {pending ? "Sending…" : "Send to the team"}
        </Button>
      </div>
    </form>
  );
}
