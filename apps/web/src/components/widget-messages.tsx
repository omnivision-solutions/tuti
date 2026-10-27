"use client";

import { cn } from "cn";
import { ChevronLeftIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, useTransition } from "react";

import { EmptyState } from "@/components/empty-state";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { useWidgetSignIn } from "@/components/widget-feedback";
import { timeAgo } from "@/lib/format";
import { WIDGET_UNSEEN_MESSAGES } from "@/lib/widget-messages";
import {
  type WidgetAuth,
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
type Visitor = { token: string; email: string };

/** Tells the page how many of the team's messages they haven't seen (the launcher's dot, Tuti.unseen). */
const tellPage = (count: number) => window.parent.postMessage({ type: WIDGET_UNSEEN_MESSAGES, count }, "*");

/**
 * A signed-out visitor's token and email, in the panel's own storage: partitioned per embedding
 * site, so the customer's page can't read it. The token expires by itself after 30 days. Kept in
 * memory too, so where storage is blocked or full they're still a visitor for this page view.
 */
const visitorStore = {
  key: (projectSlug: string) => `tuti:visitor:${projectSlug}`,
  memory: new Map<string, string>(),
  listeners: new Set<() => void>(),
  read(projectSlug: string): string | null {
    const key = visitorStore.key(projectSlug);
    try {
      return window.localStorage.getItem(key) ?? visitorStore.memory.get(key) ?? null;
    } catch {
      return visitorStore.memory.get(key) ?? null;
    }
  },
  write(projectSlug: string, visitor: Visitor | null) {
    const key = visitorStore.key(projectSlug);
    if (visitor) {
      visitorStore.memory.set(key, JSON.stringify(visitor));
    } else {
      visitorStore.memory.delete(key);
    }
    try {
      if (visitor) {
        window.localStorage.setItem(key, JSON.stringify(visitor));
      } else {
        window.localStorage.removeItem(key);
      }
    } catch {
      // Storage blocked or full: the copy in memory lasts this page view.
    }
    visitorStore.listeners.forEach((listener) => listener());
  },
  subscribe(listener: () => void) {
    visitorStore.listeners.add(listener);
    return () => visitorStore.listeners.delete(listener);
  },
};

function useVisitor(projectSlug: string): Visitor | null {
  const raw = useSyncExternalStore(visitorStore.subscribe, () => visitorStore.read(projectSlug), () => null);
  return useMemo(() => {
    try {
      const parsed = raw ? (JSON.parse(raw) as Partial<Visitor>) : null;
      return typeof parsed?.token === "string" && typeof parsed.email === "string" ? (parsed as Visitor) : null;
    } catch {
      return null;
    }
  }, [raw]);
}

/**
 * The widget's Messages tab: someone's conversations with the team. Signed in by the customer's
 * page (Tuti.identify) or on the portal itself (`portalSignedIn`); signed out, they give their
 * email to write, and the panel keeps a visitor token to show them their conversations.
 */
export function WidgetMessages({ projectSlug, portalSignedIn }: { projectSlug: string; portalSignedIn: boolean }) {
  const { signedIn } = useWidgetSignIn(projectSlug, !portalSignedIn);
  const visitor = useVisitor(projectSlug);
  const token = signedIn?.token ?? null;
  const known = portalSignedIn || !!signedIn;
  // The conversation someone signed out just started, to open once they're a visitor.
  const [started, setStarted] = useState<number | null>(null);

  // Signed in now: whoever had this browser before as a visitor isn't who's here.
  useEffect(() => {
    if (known && visitor) {
      visitorStore.write(projectSlug, null);
    }
  }, [known, visitor, projectSlug]);

  const auth = useMemo<WidgetAuth>(() => (known ? { token } : { visitor: visitor?.token ?? null }), [known, token, visitor?.token]);
  if (!known && !visitor) {
    return <FirstMessage projectSlug={projectSlug} onStarted={setStarted} />;
  }
  // Someone else here: their own Messages, from their list.
  return (
    <Messages
      key={auth.token ?? auth.visitor ?? "portal"}
      projectSlug={projectSlug}
      auth={auth}
      visitorEmail={known ? null : visitor!.email}
      opened={known ? null : started}
      onNewVisitor={setStarted}
    />
  );
}

function Messages({
  projectSlug,
  auth,
  visitorEmail,
  opened,
  onNewVisitor,
}: {
  projectSlug: string;
  auth: WidgetAuth;
  visitorEmail: string | null;
  opened: number | null;
  /** Their token had expired, so starting a conversation made them a new visitor: open it once they are. */
  onNewVisitor: (number: number) => void;
}) {
  const [view, setView] = useState<View>(opened ? { kind: "conversation", number: opened } : { kind: "list" });
  if (view.kind === "new") {
    return (
      <NewConversation
        projectSlug={projectSlug}
        auth={auth}
        visitorEmail={visitorEmail}
        onBack={() => setView({ kind: "list" })}
        onStarted={(number) => setView({ kind: "conversation", number })}
        onNewVisitor={onNewVisitor}
      />
    );
  }
  if (view.kind === "conversation") {
    return <Conversation key={view.number} projectSlug={projectSlug} auth={auth} number={view.number} onBack={() => setView({ kind: "list" })} />;
  }
  return <ConversationList projectSlug={projectSlug} auth={auth} onOpen={(number) => setView({ kind: "conversation", number })} onNew={() => setView({ kind: "new" })} />;
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
  auth,
  onOpen,
  onNew,
}: {
  projectSlug: string;
  auth: WidgetAuth;
  onOpen: (number: number) => void;
  onNew: () => void;
}) {
  const [conversations, setConversations] = useState<Listed | null>(null);
  const [error, setError] = useState<string>();
  const load = useCallback(
    async (isLatest: () => boolean) => {
      const result = await widgetConversations(projectSlug, auth);
      if (!isLatest()) {
        return;
      }
      if ("error" in result) {
        // A visitor token that no longer checks out (30 days on): they start again with their email.
        if (auth.visitor) {
          visitorStore.write(projectSlug, null);
        }
        setError(result.error);
        return;
      }
      setConversations(result.conversations);
      tellPage(result.unseen);
    },
    [projectSlug, auth],
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

/** A message box (⌘/Ctrl+Enter sends), with an email field first when `email` is given (someone signed out). */
function Composer({
  placeholder,
  label,
  email,
  send,
}: {
  placeholder: string;
  label: string;
  email?: string;
  send: (text: string, email: string) => Promise<{ error?: string }>;
}) {
  const [text, setText] = useState("");
  const [address, setAddress] = useState(email ?? "");
  const [error, setError] = useState<string>();
  const [pending, startTransition] = useTransition();
  const submit = () =>
    startTransition(async () => {
      const result = await send(text, address);
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
      {email !== undefined && (
        <Input
          type="email"
          aria-label="Your email"
          placeholder="Your email"
          autoComplete="email"
          required
          value={address}
          onChange={(event) => setAddress(event.target.value)}
        />
      )}
      <Textarea
        aria-label={label}
        placeholder={placeholder}
        value={text}
        rows={3}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && (event.metaKey || event.ctrlKey) && !pending) {
            event.preventDefault();
            event.currentTarget.form?.requestSubmit();
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

/** Someone signed out, writing for the first time: their email, so the team can reply once they've left. */
function FirstMessage({ projectSlug, onStarted }: { projectSlug: string; onStarted: (number: number) => void }) {
  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm text-muted-foreground">
        Leave your email so the team can get back to you.{" "}
        <a href="/sign-in" target="_blank" rel="noreferrer" className="underline underline-offset-4">
          Sign in
        </a>{" "}
        to see your past conversations.
      </p>
      <Composer
        label="Message"
        placeholder="How can we help?"
        email=""
        send={async (text, email) => {
          const result = await widgetStartConversation(projectSlug, {}, text, email);
          if ("error" in result) {
            return result;
          }
          onStarted(result.number);
          if (result.visitor) {
            visitorStore.write(projectSlug, { token: result.visitor, email: email.trim() });
          }
          return {};
        }}
      />
    </div>
  );
}

function NewConversation({
  projectSlug,
  auth,
  visitorEmail,
  onBack,
  onStarted,
  onNewVisitor,
}: {
  projectSlug: string;
  auth: WidgetAuth;
  visitorEmail: string | null;
  onBack: () => void;
  onStarted: (number: number) => void;
  onNewVisitor: (number: number) => void;
}) {
  return (
    <div className="flex flex-col gap-3">
      <BackButton onBack={onBack} />
      <Composer
        label="Message"
        placeholder="How can we help?"
        email={visitorEmail ?? undefined}
        send={async (text, email) => {
          const result = await widgetStartConversation(projectSlug, auth, text, visitorEmail === null ? undefined : email);
          if ("error" in result) {
            return result;
          }
          // A new token: theirs had expired. It's who they are now, and the conversation opens once they are.
          if (result.visitor) {
            onNewVisitor(result.number);
            visitorStore.write(projectSlug, { token: result.visitor, email: email.trim() });
            return {};
          }
          if (visitorEmail !== null && auth.visitor) {
            visitorStore.write(projectSlug, { token: auth.visitor, email: email.trim() });
          }
          onStarted(result.number);
          return {};
        }}
      />
    </div>
  );
}

function Conversation({ projectSlug, auth, number, onBack }: { projectSlug: string; auth: WidgetAuth; number: number; onBack: () => void }) {
  const [opened, setOpened] = useState<Opened | null>(null);
  const [error, setError] = useState<string>();
  const load = useCallback(
    async (isLatest: () => boolean) => {
      const result = await widgetConversation(projectSlug, auth, number);
      if (!isLatest()) {
        return;
      }
      if ("error" in result) {
        setError(result.error);
        return;
      }
      setOpened(result);
      // Shown, so seen: the page's count goes down.
      const listed = await widgetConversations(projectSlug, auth);
      if (isLatest() && !("error" in listed)) {
        tellPage(listed.unseen);
      }
    },
    [projectSlug, auth, number],
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
              const result = await widgetSendMessage(projectSlug, auth, number, text);
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
