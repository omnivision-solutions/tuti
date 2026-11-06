"use client";

import { SendHorizontalIcon, SparklesIcon, ThumbsDownIcon, ThumbsUpIcon, Trash2Icon, XIcon } from "lucide-react";
import Link from "next/link";
import { type FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";

import { AnswerSources, AnswerText, AskAPerson } from "@/components/docs-answer";
import { askedFrom, type DocsAssistant, DocsAssistantContext, useDocsAssistant } from "@/components/docs-assistant-context";
import { usePortalHref, usePortalSlug } from "@/components/portal-base";
import { Button, buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Sheet, SheetClose, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/sheet";
import { useWidgetSignIn } from "@/components/widget-feedback";
import { MAX_QUESTION } from "@/lib/widget-docs";
import { WIDGET_ASK_MESSAGE, WIDGET_ASK_READY_MESSAGE } from "@/lib/widget-messages";
import { askDocs, rateDocsAnswer } from "@/server/docs-readers";
import type { DocsAnswer } from "@/server/operations/docs-ask";

/** One turn of the conversation: what they asked, and the answer once it's come (or why it didn't). */
type Turn = { key: string; question: string; answer?: DocsAnswer; error?: string; rated?: boolean; /** Passed to the team (Ask a person): once. */ escalated?: boolean; /** Asked on its own, following up on nothing (a new message in Messages). */ fresh?: boolean };

/** The longest post title (MAX_POST_TITLE): "Post this as feedback" starts a post with the question as its title. */
const MAX_TITLE = 120;

/**
 * Kept for the tab's session, so the conversation survives going to an article and back; per reader
 * (the signed-in account, the one the customer's site signs in to the widget, or "anonymous"), so
 * whoever signs in next in the same tab doesn't see it.
 */
const storageKey = (slug: string, viewer: string) => `tuti:docs-assistant:${slug}:${viewer}`;

function storedTurns(slug: string, viewer: string): Turn[] {
  if (typeof window === "undefined") {
    return [];
  }
  try {
    const turns = JSON.parse(window.sessionStorage.getItem(storageKey(slug, viewer)) ?? "[]") as Turn[];
    return Array.isArray(turns) ? turns.filter((turn) => turn.answer || turn.error) : [];
  } catch {
    return [];
  }
}

/** The answer a new question follows up on: the latest that was asked (an "I don't know" too). */
const lastAsked = (turns: Turn[]) => turns.findLast((turn) => turn.answer)?.answer?.id;

/**
 * The widget's docs assistant, the one place AI answers are a conversation (the portal's Ask AI opens it too: Tuti.open({ ask })).
 * It takes the panel. Its Help center's "Ask AI", Messages' AI first, and the page around the panel (by message, once this
 * says it's listening: a question, or none to just open it, after a question and answer from elsewhere to follow up on) open it. Each question follows up on the ones before (docs.ask's `followUpTo`: the server reads the earlier turns,
 * the browser only names the last). Answers come with their sources (opening in the panel's Help center) and a thumbs up or down,
 * "I don't know" with posting it as feedback (`feedbackPath`, the Feedback tab), and each with Ask a person (`askAPerson`). The
 * trash clears the conversation; the next question starts a new one.
 */
export function DocsAssistantProvider({
  projectName,
  viewer,
  feedbackPath,
  askAPerson,
  children,
}: {
  projectName: string;
  /** Who's reading: their account's id, or null signed out (each has a conversation of their own). */
  viewer: string | null;
  feedbackPath: string | null;
  askAPerson: { email: string } | null;
  children: React.ReactNode;
}) {
  const slug = usePortalSlug();
  const [open, setOpen] = useState(false);
  // What had focus when it opened, for it to go back to; in the widget's Messages that may be gone by then (sending went
  // back to the list), and the page's mark (data-assistant-return, its New message) takes it instead.
  const opener = useRef<HTMLElement | null>(null);
  const show = useCallback(() => {
    const focused = document.activeElement;
    // Asked from its own box (a follow-up), it's open already: what opened it stays the opener.
    if (!(focused instanceof HTMLElement && focused.closest('[data-slot="sheet-content"]'))) {
      opener.current = focused instanceof HTMLElement ? focused : null;
    }
    setOpen(true);
  }, []);
  // In the widget, without the portal's sign-in: whoever the customer's site signs in (Tuti.identify),
  // asked once the assistant is first opened, since each asking costs the customer's app a token.
  const [opened, setOpened] = useState(false);
  if (open && !opened) {
    setOpened(true);
  }
  const { signedIn } = useWidgetSignIn(slug, !viewer && opened);
  const reader = viewer ?? (signedIn ? `widget:${signedIn.id}` : "anonymous");
  const key = storageKey(slug, reader);
  const [turns, setTurns] = useState<Turn[]>(() => storedTurns(slug, reader));
  // The turns asked on this page (not restored from the tab's storage).
  const [askedHere, setAskedHere] = useState<string[]>([]);
  // Where they were kept as nobody's, to remove: a new one each time (the same key can come again).
  const [leftBehind, setLeftBehind] = useState<{ key: string } | null>(null);
  // Someone else now (signed in or out without a reload): their own conversation. Except questions
  // asked on this page before the widget's sign-in came back: they're the person's it names, so
  // they go with them, after what that person asked before in this tab; what an earlier reader
  // left in it doesn't.
  const [shownFor, setShownFor] = useState(key);
  if (shownFor !== key) {
    setShownFor(key);
    const carried = turns.filter((turn) => askedHere.includes(turn.key));
    if (carried.length > 0 && shownFor === storageKey(slug, "anonymous") && signedIn) {
      setTurns([...storedTurns(slug, reader), ...carried]);
      setLeftBehind({ key: shownFor });
    } else {
      setTurns(storedTurns(slug, reader));
    }
  }
  useEffect(() => {
    if (leftBehind) {
      try {
        window.sessionStorage.removeItem(leftBehind.key);
      } catch {
        // Storage blocked: nothing was kept there.
      }
    }
  }, [leftBehind]);
  // The turns as they are now, for asking without waiting for a render.
  const turnsRef = useRef(turns);
  useEffect(() => {
    turnsRef.current = turns;
    try {
      window.sessionStorage.setItem(key, JSON.stringify(turns.filter((turn) => turn.answer || turn.error)));
    } catch {
      // Storage blocked or full: the conversation just won't outlive the page.
    }
  }, [key, turns]);

  const update = useCallback((key: string, patch: Partial<Turn>) => setTurns((all) => all.map((turn) => (turn.key === key ? { ...turn, ...patch } : turn))), []);

  /** Asks `question` as turn `key` (new, or one to try again), following up on the turns before it. */
  const run = useCallback(
    async (turn: string, question: string, before: Turn[]) => {
      try {
        const followUpTo = lastAsked(before);
        const from = askedFrom();
        const result = await askDocs(slug, question, from, followUpTo);
        // The conversation isn't theirs any more (a new reader cookie): asked afresh, as a new one.
        if (followUpTo && "code" in result && result.code === "not_found") {
          const fresh = await askDocs(slug, question, from);
          // Only into the conversation it was asked in: not someone else's, signed in meanwhile.
          setTurns((all) => (all.some((each) => each.key === turn) ? [{ key: turn, question, ...("error" in fresh ? { error: fresh.error } : { answer: fresh }) }] : all));
          return;
        }
        update(turn, "error" in result ? { error: result.error } : { answer: result, error: undefined });
      } catch {
        // Offline, or the server failed: not "Thinking…" forever.
        update(turn, { error: "Couldn't reach the assistant. Try again." });
      }
    },
    [slug, update],
  );

  const assistant = useMemo<DocsAssistant>(
    () => ({
      ask: (question, { fresh = false } = {}) => {
        const trimmed = question.trim();
        show();
        if (!trimmed) {
          return;
        }
        const before = fresh ? [] : turnsRef.current;
        const turn = crypto.randomUUID();
        setAskedHere((keys) => [...keys, turn]);
        setTurns((all) => [...all, { key: turn, question: trimmed, ...(fresh && { fresh }) }]);
        void run(turn, trimmed, before);
      },
      open: show,
      continueWith: (question, answer) => {
        setTurns((all) => (all.some((turn) => turn.answer?.id === answer.id) ? all : [...all, { key: crypto.randomUUID(), question, answer }]));
        show();
      },
    }),
    [run, show],
  );

  // Asked by the page around the panel (Tuti.open({ ask }), the portal's Ask AI): by message, once it hears this is listening.
  // A question and answer from elsewhere (a search's "Ask a follow-up") come first, to follow up on.
  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      const data = event.data as { type?: unknown; ask?: unknown; turn?: unknown } | null;
      if (event.source !== window.parent || data?.type !== WIDGET_ASK_MESSAGE || typeof data.ask !== "string") {
        return;
      }
      // Only a turn shaped as an answer is (the page's, so nothing it couldn't show itself), or the conversation would break.
      const turn = data.turn as { question?: unknown; answer?: Partial<Record<keyof DocsAnswer, unknown>> } | null | undefined;
      const answered = turn?.answer;
      if (
        typeof turn?.question === "string" &&
        answered &&
        typeof answered.id === "string" &&
        typeof answered.status === "string" &&
        Array.isArray(answered.sources) &&
        (typeof answered.answer === "string" || answered.answer === null || answered.answer === undefined)
      ) {
        const { question, answer } = turn as { question: string; answer: DocsAnswer };
        setTurns((all) => (all.some((each) => each.answer?.id === answer.id) ? all : [...all, { key: crypto.randomUUID(), question, answer }]));
      }
      if (data.ask.trim()) {
        assistant.ask(data.ask.slice(0, MAX_QUESTION));
      } else {
        assistant.open();
      }
    };
    window.addEventListener("message", onMessage);
    // Saying which page, so the loader doesn't take it from one it has replaced; and that it's stopped, as the page goes.
    const stopped = () => window.parent.postMessage({ type: WIDGET_ASK_READY_MESSAGE, listening: false }, "*");
    if (window.parent !== window) {
      window.parent.postMessage({ type: WIDGET_ASK_READY_MESSAGE, href: window.location.href }, "*");
      window.addEventListener("pagehide", stopped);
    }
    return () => {
      window.removeEventListener("message", onMessage);
      window.removeEventListener("pagehide", stopped);
    };
  }, [assistant]);

  const retry = (turn: Turn) => {
    const before = turn.fresh ? [] : turnsRef.current.slice(0, turnsRef.current.findIndex((each) => each.key === turn.key));
    update(turn.key, { answer: undefined, error: undefined });
    void run(turn.key, turn.question, before);
  };

  return (
    <DocsAssistantContext.Provider value={assistant}>
      {children}
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent
          side="right"
          showCloseButton={false}
          finalFocus={() => (opener.current?.isConnected ? opener.current : (document.querySelector<HTMLElement>("[data-assistant-return]") ?? true))}
          className="w-full gap-0 p-0 data-[side=right]:w-full data-[side=right]:sm:max-w-lg">
          <AssistantPanel
            projectName={projectName}
            turns={turns}
            feedbackPath={feedbackPath}
            askAPerson={askAPerson}
            onAsk={assistant.ask}
            onRetry={retry}
            onRated={(turn, helpful) => update(turn.key, { rated: helpful })}
            onEscalated={(turn) => update(turn.key, { escalated: true })}
            onClear={() => setTurns([])}
            onLeave={() => setOpen(false)}
          />
        </SheetContent>
      </Sheet>
    </DocsAssistantContext.Provider>
  );
}

function AssistantPanel({
  projectName,
  turns,
  feedbackPath,
  askAPerson,
  onAsk,
  onRetry,
  onRated,
  onEscalated,
  onClear,
  onLeave,
}: {
  projectName: string;
  turns: Turn[];
  feedbackPath: string | null;
  askAPerson: { email: string } | null;
  onAsk: (question: string) => void;
  onRetry: (turn: Turn) => void;
  onRated: (turn: Turn, helpful: boolean) => void;
  onEscalated: (turn: Turn) => void;
  onClear: () => void;
  onLeave: () => void;
}) {
  const [draft, setDraft] = useState("");
  const end = useRef<HTMLDivElement>(null);
  const thinking = turns.some((turn) => !turn.answer && !turn.error);
  // The latest turn in view as it's asked and as its answer comes.
  const latest = turns.at(-1);
  // In braces: browsers may return a promise from scrollIntoView, which an effect mustn't return.
  useEffect(() => {
    end.current?.scrollIntoView({ block: "end" });
  }, [turns.length, latest?.answer, latest?.error]);

  const send = (event: FormEvent) => {
    event.preventDefault();
    if (!draft.trim() || thinking) {
      return;
    }
    onAsk(draft);
    setDraft("");
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-1 border-b py-2 pr-2 pl-4">
        <SheetTitle className="flex-1 text-base">Assistant</SheetTitle>
        <SheetDescription className="sr-only">Ask about {projectName}: answers written by AI from the docs.</SheetDescription>
        <Button variant="ghost" size="icon-sm" aria-label="Clear the conversation" disabled={turns.length === 0 || thinking} onClick={onClear}>
          <Trash2Icon />
        </Button>
        <SheetClose render={<Button variant="ghost" size="icon-sm" aria-label="Close the assistant" />}>
          <XIcon />
        </SheetClose>
      </div>
      <div role="log" aria-label="Conversation" aria-busy={thinking} className="flex min-h-0 flex-1 flex-col gap-6 overflow-y-auto px-4 py-5">
        {turns.length === 0 && (
          <div className="m-auto flex max-w-xs flex-col items-center gap-2 text-center text-sm text-muted-foreground">
            <SparklesIcon aria-hidden className="size-6" />
            <p>Ask anything about {projectName}. Answers are written by AI from the docs, with the articles they come from.</p>
          </div>
        )}
        {turns.map((turn) => (
          <div key={turn.key} className="flex flex-col gap-4">
            <p className="ml-auto max-w-[85%] rounded-2xl bg-muted px-4 py-2.5 break-words">{turn.question}</p>
            <AssistantReply
              turn={turn}
              feedbackPath={feedbackPath}
              askAPerson={askAPerson}
              onRetry={() => onRetry(turn)}
              onRated={(helpful) => onRated(turn, helpful)}
              onEscalated={() => onEscalated(turn)}
              onLeave={onLeave}
            />
          </div>
        ))}
        <div ref={end} />
      </div>
      <form onSubmit={send} className="flex items-center gap-2 border-t p-3">
        <Input
          autoFocus
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          maxLength={300}
          placeholder="Ask, search, or explain…"
          aria-label={turns.length > 0 ? "Ask a follow-up" : "Ask a question"}
          className="h-11 flex-1"
        />
        <Button type="submit" size="lg" disabled={!draft.trim() || thinking} aria-label="Send">
          <SendHorizontalIcon />
          <span className="max-sm:sr-only">Send</span>
        </Button>
      </form>
    </div>
  );
}

function AssistantReply({
  turn,
  feedbackPath,
  askAPerson,
  onRetry,
  onRated,
  onEscalated,
  onLeave,
}: {
  turn: Turn;
  feedbackPath: string | null;
  askAPerson: { email: string } | null;
  onRetry: () => void;
  onRated: (helpful: boolean) => void;
  onEscalated: () => void;
  onLeave: () => void;
}) {
  const slug = usePortalSlug();
  const at = usePortalHref();
  const [rating, setRating] = useState(false);
  const { answer, error } = turn;

  if (error) {
    return (
      <div className="flex flex-col items-start gap-2 text-sm">
        {/* Passed to the team, it isn't asked again: that would be a second way to the team for it. */}
        {!turn.escalated && (
          <>
            <p className="text-destructive">{error}</p>
            <Button variant="outline" size="sm" onClick={onRetry}>
              Try again
            </Button>
          </>
        )}
        {/* Where Messages asks the AI first, the team is still a way through: the question as it was, unanswered. */}
        {askAPerson && (
          <AskAPerson
            projectSlug={slug}
            questionId={null}
            question={turn.question}
            defaultEmail={askAPerson.email}
            widget
            sent={turn.escalated}
            onSent={onEscalated}
            onLeave={onLeave}
          />
        )}
      </div>
    );
  }
  if (!answer) {
    return (
      <p role="status" className="flex items-center gap-2 text-muted-foreground">
        <SparklesIcon aria-hidden className="size-4 animate-pulse" />
        Thinking…
      </p>
    );
  }
  const person = askAPerson && (
    <AskAPerson
      projectSlug={slug}
      questionId={answer.id}
      question={turn.question}
      defaultEmail={askAPerson.email}
      widget
      sent={turn.escalated}
      onSent={onEscalated}
      onLeave={onLeave}
    />
  );
  // An article opens in the panel's Help center (the portal's page is a link away from there).
  const sourceHref = (article: string) => at(`/widget?${new URLSearchParams({ tab: "docs", article })}`);
  if (answer.status === "failed") {
    return (
      <div className="flex flex-col items-start gap-2 text-sm">
        <p className="text-muted-foreground">The AI couldn&apos;t answer just now.</p>
        {!turn.escalated && (
          <Button variant="outline" size="sm" onClick={onRetry}>
            Try again
          </Button>
        )}
        {person}
        {answer.sources.length > 0 && <AnswerSources sources={answer.sources} href={sourceHref} onOpen={onLeave} />}
      </div>
    );
  }
  if (answer.status !== "answered") {
    const feedbackHref = feedbackPath && at(`${feedbackPath}${feedbackPath.includes("?") ? "&" : "?"}${new URLSearchParams({ title: turn.question.slice(0, MAX_TITLE) })}`);
    return (
      <div className="flex flex-col gap-2">
        <p className="font-semibold">
          {answer.status === "no_answer" ? "I don't know" : answer.status === "unavailable" ? "AI answers aren't available right now." : "I can't help with that here."}
        </p>
        <p className="text-sm text-muted-foreground">
          {answer.status === "no_answer"
            ? "Nothing in the docs answers that yet. Post it as feedback so the team sees it."
            : answer.status === "unavailable"
              ? "These articles may help. Or post it as feedback so the team sees it."
              : "Post it as feedback so the team sees it."}
        </p>
        {/* The project's AI is paused (out of AI credits): the closest articles instead. */}
        {answer.status === "unavailable" && answer.sources.length > 0 && <AnswerSources sources={answer.sources} href={sourceHref} onOpen={onLeave} />}
        <div className="flex flex-wrap items-center gap-2">
          {feedbackHref && (
            <Link href={feedbackHref} onClick={onLeave} className={buttonVariants({ variant: "outline", size: "sm" })}>
              Post this as feedback
            </Link>
          )}
          {person}
        </div>
      </div>
    );
  }
  const rate = async (helpful: boolean) => {
    setRating(true);
    try {
      const result = await rateDocsAnswer(slug, answer.id, helpful);
      if (!result.error) {
        onRated(helpful);
      }
    } catch {
      // Offline, or the server failed: the buttons stay, to try again.
    } finally {
      setRating(false);
    }
  };
  return (
    <div className="flex flex-col gap-4">
      <AnswerText text={answer.answer ?? ""} />
      <div className="flex flex-wrap items-center gap-1 text-sm text-muted-foreground">
        {turn.rated === undefined ? (
          <>
            <Button variant="ghost" size="icon-sm" aria-label="Helpful" disabled={rating} onClick={() => void rate(true)}>
              <ThumbsUpIcon />
            </Button>
            <Button variant="ghost" size="icon-sm" aria-label="Not helpful" disabled={rating} onClick={() => void rate(false)}>
              <ThumbsDownIcon />
            </Button>
          </>
        ) : (
          <p>Thanks for letting us know.</p>
        )}
        {/* Always there: Messages asks the AI first, and the team is a way through. */}
        {person}
      </div>
      <AnswerSources sources={answer.sources} href={sourceHref} onOpen={onLeave} />
    </div>
  );
}

/**
 * In the widget's Docs tab: "Ask AI", opening the assistant as it was, or with `question` (a search),
 * "Ask AI: <question>", asking it there (`onAsk` then too). Nothing without an assistant.
 */
export function AskAIButton({ question, onAsk }: { question?: string; onAsk?: () => void }) {
  const assistant = useDocsAssistant();
  if (!assistant) {
    return null;
  }
  if (!question) {
    return (
      <Button type="button" variant="outline" onClick={assistant.open}>
        <SparklesIcon />
        Ask AI
      </Button>
    );
  }
  return (
    <button
      type="button"
      onClick={() => {
        onAsk?.();
        assistant.ask(question);
      }}
      className="flex w-full items-center gap-2 rounded-lg bg-muted px-3 py-2.5 text-left text-sm transition-colors hover:bg-accent"
    >
      <SparklesIcon aria-hidden className="size-4 shrink-0" />
      <span className="shrink-0 font-medium">Ask AI:</span>
      <span className="truncate text-muted-foreground">{question}</span>
    </button>
  );
}

/** Where the project answers messages (supportContact): Messages in the widget, and its email address. */
export type SupportContact = { messages: boolean; email: string | null };

/**
 * "Still stuck?" at the end of an article: Ask AI (where the portal has the assistant) and a way to
 * reach the team: "Contact us" where the project answers messages (`support`), opening the widget's Messages when the widget is on the page (the
 * team's own code may add it), else an email to the support address (or the widget's Messages on a
 * page of their own). Only what's set up; nothing without any of them.
 */
export function StillStuck({ support }: { support: SupportContact | null }) {
  const assistant = useDocsAssistant();
  const at = usePortalHref();
  if (!assistant && !support) {
    return null;
  }
  return (
    <section aria-labelledby="still-stuck" className="flex flex-wrap items-center gap-3 rounded-xl bg-muted/60 p-4">
      <h2 id="still-stuck" className="mr-auto font-semibold">
        Still stuck?
      </h2>
      {assistant && (
        <Button variant="outline" size="sm" onClick={assistant.open}>
          <SparklesIcon />
          Ask AI
        </Button>
      )}
      {support && (
          <a
            href={support.email ? `mailto:${support.email}` : at("/widget?tab=messages")}
            {...(!support.email && { target: "_blank", rel: "noopener" })}
            onClick={(event) => {
              const widget = (window as { Tuti?: { open: (options: { tab: string }) => void } }).Tuti;
              if (support.messages && widget) {
                event.preventDefault();
                widget.open({ tab: "messages" });
              }
            }}
            className={buttonVariants({ size: "sm" })}
          >
            Contact us
          </a>
      )}
    </section>
  );
}
