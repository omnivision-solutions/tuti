"use client";

import { cn } from "cn";
import { ChevronLeftIcon } from "lucide-react";
import { useCallback, useEffect, useRef, useState, useTransition } from "react";

import { EmptyState } from "@/components/empty-state";
import { Button, buttonVariants } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { useWidgetSignIn } from "@/components/widget-feedback";
import { timeAgo } from "@/lib/format";
import { WIDGET_UNSEEN_MESSAGES } from "@/lib/widget-messages";
import {
  widgetConversation,
  widgetConversations,
  widgetSendMessage,
  widgetStartConversation,
} from "@/server/widget-inbox";

/** How often an open Messages tab checks for replies (live updates come later). */
const POLL_MS = 10_000;

type View = { kind: "list" } | { kind: "new" } | { kind: "conversation"; number: number };
type Listed = Extract<Awaited<ReturnType<typeof widgetConversations>>, { conversations: unknown }>["conversations"];
type Opened = Extract<Awaited<ReturnType<typeof widgetConversation>>, { messages: unknown }>;

/** Tells the page how many of the team's messages they haven't seen (the launcher's dot, Tuti.unseen). */
const tellPage = (count: number) => window.parent.postMessage({ type: WIDGET_UNSEEN_MESSAGES, count }, "*");

/**
 * The widget's Messages tab: the signed-in person's conversations with the team. Signed in by
 * the customer's page (Tuti.identify), or on the portal itself (`portalSignedIn`).
 */
export function WidgetMessages({ projectSlug, portalSignedIn }: { projectSlug: string; portalSignedIn: boolean }) {
  const { signedIn, error } = useWidgetSignIn(projectSlug, !portalSignedIn);
  const token = portalSignedIn ? null : (signedIn?.token ?? null);
  if (!portalSignedIn && !signedIn) {
    return (
      <div className="flex flex-col items-start gap-3">
        {error && <p className="text-sm text-destructive">{error}</p>}
        <p className="text-sm text-muted-foreground">Sign in to message the team. It opens in a new tab.</p>
        <a href="/sign-in" target="_blank" rel="noreferrer" className={buttonVariants()}>
          Sign in
        </a>
      </div>
    );
  }
  // Someone else signed in: their own Messages, from their list.
  return <Messages key={token ?? "portal"} projectSlug={projectSlug} token={token} />;
}

function Messages({ projectSlug, token }: { projectSlug: string; token: string | null }) {
  const [view, setView] = useState<View>({ kind: "list" });
  if (view.kind === "new") {
    return <NewConversation projectSlug={projectSlug} token={token} onBack={() => setView({ kind: "list" })} onStarted={(number) => setView({ kind: "conversation", number })} />;
  }
  if (view.kind === "conversation") {
    return <Conversation key={view.number} projectSlug={projectSlug} token={token} number={view.number} onBack={() => setView({ kind: "list" })} />;
  }
  return <ConversationList projectSlug={projectSlug} token={token} onOpen={(number) => setView({ kind: "conversation", number })} onNew={() => setView({ kind: "new" })} />;
}

/**
 * Runs `load` now and every POLL_MS while shown, and returns a way to run it again (after sending).
 * Runs can overlap: `load` gets `isLatest`, to check after each await that no newer run started
 * (and that it's still shown) before it shows what it got.
 */
function usePolling(load: (isLatest: () => boolean) => Promise<void>) {
  const sequence = useRef(0);
  const mounted = useRef(false);
  const run = useCallback(() => {
    const mine = ++sequence.current;
    return load(() => mounted.current && mine === sequence.current);
  }, [load]);
  useEffect(() => {
    mounted.current = true;
    void run();
    const timer = setInterval(() => void run(), POLL_MS);
    return () => {
      mounted.current = false;
      clearInterval(timer);
    };
  }, [run]);
  return run;
}

function ConversationList({
  projectSlug,
  token,
  onOpen,
  onNew,
}: {
  projectSlug: string;
  token: string | null;
  onOpen: (number: number) => void;
  onNew: () => void;
}) {
  const [conversations, setConversations] = useState<Listed | null>(null);
  const [error, setError] = useState<string>();
  const load = useCallback(
    async (isLatest: () => boolean) => {
      const result = await widgetConversations(projectSlug, token);
      if (!isLatest()) {
        return;
      }
      if ("error" in result) {
        setError(result.error);
        return;
      }
      setConversations(result.conversations);
      tellPage(result.unseen);
    },
    [projectSlug, token],
  );
  usePolling(load);

  return (
    <div className="flex flex-col gap-3">
      <Button onClick={onNew} className="self-start">
        New message
      </Button>
      {error && <p className="text-sm text-destructive">{error}</p>}
      {conversations?.length === 0 && <EmptyState title="No messages yet" description="Write to the team and they'll reply here." />}
      {conversations && conversations.length > 0 && (
        <ul className="flex flex-col divide-y rounded-xl border" aria-label="Conversations">
          {conversations.map((c) => (
            <li key={c.number}>
              <button type="button" onClick={() => onOpen(c.number)} className="flex w-full items-center gap-2 px-3 py-2.5 text-left hover:bg-accent">
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className={cn("truncate text-sm", c.unseen > 0 && "font-semibold")}>{c.subject}</span>
                  <span className="text-xs text-muted-foreground">{timeAgo(new Date(c.lastMessageAt))}</span>
                </span>
                {c.unseen > 0 && (
                  <span className="size-2.5 shrink-0 rounded-full bg-[oklch(0.705_0.187_47.6)]">
                    <span className="sr-only">New reply</span>
                  </span>
                )}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function Composer({ placeholder, send, label }: { placeholder: string; label: string; send: (text: string) => Promise<{ error?: string }> }) {
  const [text, setText] = useState("");
  const [error, setError] = useState<string>();
  const [pending, startTransition] = useTransition();
  const submit = () =>
    startTransition(async () => {
      const result = await send(text);
      setError(result.error);
      if (!result.error) {
        setText("");
      }
    });
  return (
    <form
      className="flex flex-col gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <Textarea
        aria-label={label}
        placeholder={placeholder}
        value={text}
        rows={3}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && (event.metaKey || event.ctrlKey) && !pending) {
            event.preventDefault();
            submit();
          }
        }}
      />
      {error && <p className="text-sm text-destructive">{error}</p>}
      <Button type="submit" disabled={pending} className="self-end">
        {pending ? "Sending…" : "Send"}
      </Button>
    </form>
  );
}

function BackButton({ onBack }: { onBack: () => void }) {
  return (
    <Button variant="ghost" size="sm" onClick={onBack} className="-ml-2 self-start">
      <ChevronLeftIcon />
      Messages
    </Button>
  );
}

function NewConversation({
  projectSlug,
  token,
  onBack,
  onStarted,
}: {
  projectSlug: string;
  token: string | null;
  onBack: () => void;
  onStarted: (number: number) => void;
}) {
  return (
    <div className="flex flex-col gap-3">
      <BackButton onBack={onBack} />
      <Composer
        label="Message"
        placeholder="How can we help?"
        send={async (text) => {
          const result = await widgetStartConversation(projectSlug, token, text);
          if ("error" in result) {
            return result;
          }
          onStarted(result.number);
          return {};
        }}
      />
    </div>
  );
}

function Conversation({ projectSlug, token, number, onBack }: { projectSlug: string; token: string | null; number: number; onBack: () => void }) {
  const [opened, setOpened] = useState<Opened | null>(null);
  const [error, setError] = useState<string>();
  const load = useCallback(
    async (isLatest: () => boolean) => {
      const result = await widgetConversation(projectSlug, token, number);
      if (!isLatest()) {
        return;
      }
      if ("error" in result) {
        setError(result.error);
        return;
      }
      setOpened(result);
      // Shown, so seen: the page's count goes down.
      const listed = await widgetConversations(projectSlug, token);
      if (isLatest() && !("error" in listed)) {
        tellPage(listed.unseen);
      }
    },
    [projectSlug, token, number],
  );
  const reload = usePolling(load);

  return (
    <div className="flex flex-col gap-3">
      <BackButton onBack={onBack} />
      {error && <p className="text-sm text-destructive">{error}</p>}
      {opened && (
        <>
          <h2 className="font-medium break-words">{opened.subject}</h2>
          <ol className="flex flex-col gap-2" aria-label="Messages">
            {opened.messages.map((m) => (
              <li key={m.id} className={cn("flex", !m.fromTeam && "justify-end")}>
                <div className={cn("max-w-[85%] rounded-xl border px-3 py-2", !m.fromTeam && "bg-muted")}>
                  <p className="text-xs text-muted-foreground">
                    {m.fromTeam ? (m.name ?? "The team") : "You"} · {timeAgo(new Date(m.createdAt))}
                  </p>
                  <p className="text-sm break-words whitespace-pre-wrap">{m.body}</p>
                </div>
              </li>
            ))}
          </ol>
          <Composer
            label="Reply"
            placeholder="Write a reply…"
            send={async (text) => {
              const result = await widgetSendMessage(projectSlug, token, number, text);
              if (!("error" in result)) {
                await reload();
              }
              return result;
            }}
          />
        </>
      )}
    </div>
  );
}
