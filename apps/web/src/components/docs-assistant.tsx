"use client";

import { SendHorizontalIcon, SparklesIcon, ThumbsDownIcon, ThumbsUpIcon, Trash2Icon, XIcon } from "lucide-react";
import Link from "next/link";
import { type FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";

import { AnswerSources, AnswerText, AskAPerson } from "@/components/docs-answer";
import { type DocsAssistant, DocsAssistantContext, useDocsAssistant } from "@/components/docs-assistant-context";
import { usePortalHref, usePortalSlug } from "@/components/portal-base";
import { Button, buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Sheet, SheetClose, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/sheet";
import { useWidgetSignIn } from "@/components/widget-feedback";
import { askDocs, rateDocsAnswer } from "@/server/docs-readers";
import type { DocsAnswer } from "@/server/operations/docs-ask";

/** One turn of the conversation: what they asked, and the answer once it's come (or why it didn't). */
type Turn = { key: string; question: string; answer?: DocsAnswer; error?: string; rated?: boolean };

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
 * The portal's docs assistant: AI answers as a conversation, in a panel (the whole screen on phones).
 * Asking from the search box ("Ask AI") or the header's button opens it; each question follows up on
 * the ones before (docs.ask's `followUpTo`: the server reads the earlier turns, the browser only names
 * the last). Answers come with their sources and a thumbs up or down; "I don't know" with posting it
 * as feedback (`feedbackPath`: the first board's) and, when the team takes questions by email, asking a
 * person (`askAPerson`). The trash clears the conversation; the next question starts a new one.
 * In the widget (`widget`), it takes the panel: questions count as the widget's, sources open in the
 * panel's Docs tab, and "Post this as feedback" opens its Feedback tab (`feedbackPath` "/widget").
 */
export function DocsAssistantProvider({
  projectName,
  viewer,
  feedbackPath,
  askAPerson,
  widget = false,
  children,
}: {
  projectName: string;
  /** Who's reading: their account's id, or null signed out (each has a conversation of their own). */
  viewer: string | null;
  feedbackPath: string | null;
  askAPerson: { email: string } | null;
  widget?: boolean;
  children: React.ReactNode;
}) {
  const slug = usePortalSlug();
  const from = widget ? "widget" : "portal";
  const [open, setOpen] = useState(false);
  // In the widget, without the portal's sign-in: whoever the customer's site signs in (Tuti.identify),
  // asked once the assistant is first opened, since each asking costs the customer's app a token.
  const [opened, setOpened] = useState(false);
  if (open && !opened) {
    setOpened(true);
  }
  const { signedIn } = useWidgetSignIn(slug, widget && !viewer && opened);
  const reader = viewer ?? (signedIn ? `widget:${signedIn.id}` : "anonymous");
  const key = storageKey(slug, reader);
  const [turns, setTurns] = useState<Turn[]>(() => storedTurns(slug, reader));
  // The turns asked on this page (not restored from the tab's storage).
  const [askedHere, setAskedHere] = useState<string[]>([]);
  const [leftBehind, setLeftBehind] = useState<string | null>(null);
  // Someone else now (signed in or out without a reload): their own conversation. Except questions
  // asked on this page before the widget's sign-in came back: they're the person's it names, so
  // they go with them; what an earlier reader left in this tab doesn't.
  const [shownFor, setShownFor] = useState(key);
  if (shownFor !== key) {
    setShownFor(key);
    const carried = turns.filter((turn) => askedHere.includes(turn.key));
    if (carried.length > 0 && shownFor === storageKey(slug, "anonymous") && signedIn) {
      setTurns(carried);
      setLeftBehind(shownFor);
    } else {
      setTurns(storedTurns(slug, reader));
    }
  }
  useEffect(() => {
    if (leftBehind) {
      try {
        window.sessionStorage.removeItem(leftBehind);
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
    [slug, from, update],
  );

  const assistant = useMemo<DocsAssistant>(
    () => ({
      ask: (question) => {
        const trimmed = question.trim();
        setOpen(true);
        if (!trimmed) {
          return;
        }
        const before = turnsRef.current;
        const turn = crypto.randomUUID();
        setAskedHere((keys) => [...keys, turn]);
        setTurns((all) => [...all, { key: turn, question: trimmed }]);
        void run(turn, trimmed, before);
      },
      open: () => setOpen(true),
      continueWith: (question, answer) => {
        setTurns((all) => (all.some((turn) => turn.answer?.id === answer.id) ? all : [...all, { key: crypto.randomUUID(), question, answer }]));
        setOpen(true);
      },
    }),
    [run],
  );

  const retry = (turn: Turn) => {
    const before = turnsRef.current.slice(0, turnsRef.current.findIndex((each) => each.key === turn.key));
    update(turn.key, { answer: undefined, error: undefined });
    void run(turn.key, turn.question, before);
  };

  return (
    <DocsAssistantContext.Provider value={assistant}>
      {children}
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent side="right" showCloseButton={false} className="w-full gap-0 p-0 data-[side=right]:w-full data-[side=right]:sm:max-w-lg">
          <AssistantPanel
            projectName={projectName}
            turns={turns}
            feedbackPath={feedbackPath}
            askAPerson={askAPerson}
            widget={widget}
            onAsk={assistant.ask}
            onRetry={retry}
            onRated={(turn, helpful) => update(turn.key, { rated: helpful })}
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
  widget,
  onAsk,
  onRetry,
  onRated,
  onClear,
  onLeave,
}: {
  projectName: string;
  turns: Turn[];
  feedbackPath: string | null;
  askAPerson: { email: string } | null;
  widget: boolean;
  onAsk: (question: string) => void;
  onRetry: (turn: Turn) => void;
  onRated: (turn: Turn, helpful: boolean) => void;
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
              widget={widget}
              onRetry={() => onRetry(turn)}
              onRated={(helpful) => onRated(turn, helpful)}
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
  widget,
  onRetry,
  onRated,
  onLeave,
}: {
  turn: Turn;
  feedbackPath: string | null;
  askAPerson: { email: string } | null;
  widget: boolean;
  onRetry: () => void;
  onRated: (helpful: boolean) => void;
  onLeave: () => void;
}) {
  const slug = usePortalSlug();
  const at = usePortalHref();
  const [rating, setRating] = useState(false);
  const { answer, error } = turn;

  if (error) {
    return (
      <div className="flex flex-col items-start gap-2 text-sm">
        <p className="text-destructive">{error}</p>
        <Button variant="outline" size="sm" onClick={onRetry}>
          Try again
        </Button>
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
  const person = askAPerson && <AskAPerson projectSlug={slug} questionId={answer.id} defaultEmail={askAPerson.email} widget={widget} />;
  // In the widget, an article opens in the panel's Docs tab (the portal's page is a link away from there).
  const sourceHref = widget ? (article: string) => `/widget?${new URLSearchParams({ tab: "docs", article })}` : undefined;
  if (answer.status === "failed") {
    return (
      <div className="flex flex-col items-start gap-2 text-sm">
        <p className="text-muted-foreground">The AI couldn&apos;t answer just now.</p>
        <Button variant="outline" size="sm" onClick={onRetry}>
          Try again
        </Button>
        {answer.sources.length > 0 && <AnswerSources sources={answer.sources} href={sourceHref} onOpen={onLeave} />}
      </div>
    );
  }
  if (answer.status !== "answered") {
    const feedbackHref = feedbackPath && at(`${feedbackPath}?${new URLSearchParams({ title: turn.question.slice(0, MAX_TITLE) })}`);
    return (
      <div className="flex flex-col gap-2">
        <p className="font-semibold">{answer.status === "no_answer" ? "I don't know" : "I can't help with that here."}</p>
        <p className="text-sm text-muted-foreground">
          {answer.status === "no_answer" ? "Nothing in the docs answers that yet. Post it as feedback so the team sees it." : "Post it as feedback so the team sees it."}
        </p>
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
        {turn.rated === false && person}
      </div>
      <AnswerSources sources={answer.sources} href={sourceHref} onOpen={onLeave} />
    </div>
  );
}

/** The header's button on Docs that opens the assistant (with the conversation as it was). */
export function AssistantButton() {
  const assistant = useDocsAssistant();
  if (!assistant) {
    return null;
  }
  return (
    // Just its icon on phones, beside the search icon.
    <Button variant="outline" size="sm" aria-label="Ask AI" onClick={assistant.open} className="max-md:size-8 max-md:border-transparent max-md:px-0">
      <SparklesIcon />
      <span className="max-md:hidden">Ask AI</span>
    </Button>
  );
}

/**
 * In the widget's Docs tab: "Ask AI", opening the assistant as it was, or with `question` (a search),
 * "Ask AI: <question>", asking it there. Nothing without an assistant.
 */
export function AskAIButton({ question }: { question?: string }) {
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
      onClick={() => assistant.ask(question)}
      className="flex w-full items-center gap-2 rounded-lg bg-muted px-3 py-2.5 text-left text-sm transition-colors hover:bg-accent"
    >
      <SparklesIcon aria-hidden className="size-4 shrink-0" />
      <span className="shrink-0 font-medium">Ask AI:</span>
      <span className="truncate text-muted-foreground">{question}</span>
    </button>
  );
}
