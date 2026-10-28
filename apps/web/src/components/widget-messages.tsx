"use client";

import { cn } from "cn";
import { ChevronLeftIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, useTransition } from "react";

import { AttachButton, type StartUpload, UploadList, useUploads } from "@/components/attachment-uploads";
import { EmptyState } from "@/components/empty-state";
import { MessageAttachments } from "@/components/inbox/message-attachments";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { useWidgetSignIn } from "@/components/widget-feedback";
import { timeAgo } from "@/lib/format";
import { WIDGET_SHOWN_MESSAGE, WIDGET_UNSEEN_MESSAGES } from "@/lib/widget-messages";
import {
  widgetConversation,
  widgetConversations,
  widgetHere,
  widgetSendMessage,
  widgetStartConversation,
  widgetUploadAttachment,
} from "@/server/widget-inbox";
import type { WidgetAuth } from "@/server/widget-person";

/** How often an open Messages tab checks for replies when its live stream can't stay open. */
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
export const visitorStore = {
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

export function useVisitor(projectSlug: string): Visitor | null {
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
  const { signedIn, error, known: pageAnswered, pending: pageSigningIn } = useWidgetSignIn(projectSlug, !portalSignedIn);
  const visitor = useVisitor(projectSlug);
  const token = signedIn?.token ?? null;
  // The page signed out whoever was here: the team's messages to them aren't anyone's now (their
  // counts stopped with their Messages, so this is the page's last word; a visitor's own come after).
  // Not when this frame's own exchange failed: another panel may have the page's person, and their count.
  const wasSignedIn = useRef(false);
  useEffect(() => {
    if (signedIn) {
      wasSignedIn.current = true;
    } else if (wasSignedIn.current && !portalSignedIn && !error) {
      wasSignedIn.current = false;
      tellPage(0);
    }
  }, [signedIn, portalSignedIn, error]);
  // Signed in on the portal in another tab since this panel loaded: the server knows them by its cookie now.
  const [signedInSince, setSignedInSince] = useState(false);
  const known = portalSignedIn || !!signedIn || signedInSince;
  // The conversation someone signed out just started, to open once they're a visitor.
  const [started, setStarted] = useState<number | null>(null);

  // Signed in now: whoever had this browser before as a visitor isn't who's here.
  useEffect(() => {
    if (known && visitor) {
      visitorStore.write(projectSlug, null);
    }
  }, [known, visitor, projectSlug]);

  const auth = useMemo<WidgetAuth>(() => (known ? { token } : { visitor: visitor?.token ?? null }), [known, token, visitor?.token]);
  // Until the page says who's here, nobody writes as a visitor, new or returning: someone it's about
  // to sign in would write in a conversation they'd lose sight of once it does.
  if (!known && !pageAnswered) {
    return <p className="text-sm text-muted-foreground">Loading…</p>;
  }
  // A sign-in that came later, still being traded: what's on screen stays (with anything typed), but can't be sent.
  const signingIn = !known && pageSigningIn;
  // The page signed someone in but their token didn't trade: say so, or they'd write as a visitor not knowing why.
  const failed = error && !known && <p className="text-sm text-destructive">{error}</p>;
  const view =
    !known && !visitor ? (
      <FirstMessage
        projectSlug={projectSlug}
        onStarted={setStarted}
        onSignedIn={(number) => {
          setStarted(number);
          setSignedInSince(true);
        }}
      />
    ) : (
      // Someone else here: their own Messages, from their list.
      <Messages
        key={auth.token ?? auth.visitor ?? "portal"}
        projectSlug={projectSlug}
        auth={auth}
        visitorEmail={known ? null : visitor!.email}
        opened={known && !signedInSince ? null : started}
        onNewVisitor={setStarted}
      />
    );
  return (
    <div className="flex flex-col gap-3">
      {failed}
      {signingIn && <p className="text-sm text-muted-foreground">Loading…</p>}
      <fieldset disabled={signingIn} className="m-0 min-w-0 border-0 p-0">
        {view}
      </fieldset>
    </div>
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
  const live = useLive(projectSlug, auth);
  useHere(projectSlug, auth);
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
    return <Conversation key={view.number} projectSlug={projectSlug} auth={auth} live={live} number={view.number} onBack={() => setView({ kind: "list" })} />;
  }
  return (
    <ConversationList
      projectSlug={projectSlug}
      auth={auth}
      live={live}
      onOpen={(number) => setView({ kind: "conversation", number })}
      onNew={() => setView({ kind: "new" })}
    />
  );
}

/** While their Messages is on screen, tells the team they're here (now, then every minute); a hidden panel doesn't. */
function useHere(projectSlug: string, auth: WidgetAuth) {
  const shown = useShown();
  useEffect(() => {
    if (!shown) {
      return;
    }
    const here = () => void widgetHere(projectSlug, auth).catch(() => {});
    here();
    const timer = setInterval(here, 60_000);
    return () => clearInterval(timer);
  }, [projectSlug, auth, shown]);
}

/**
 * Whether the panel is on screen: the page's script says when it opens and closes the floating one
 * (an inline panel, or one just opened, is shown), and again when the panel says it's ready. A hidden
 * panel keeps its place but sees nothing. Heard from the start, not once a view that asks mounts:
 * closed while it was still loading is closed.
 */
const shownStore = {
  shown: true,
  listeners: new Set<() => void>(),
  subscribe(listener: () => void) {
    shownStore.listeners.add(listener);
    return () => shownStore.listeners.delete(listener);
  },
};
if (typeof window !== "undefined") {
  window.addEventListener("message", (event: MessageEvent) => {
    const data = event.data as { type?: unknown; shown?: unknown } | null;
    if (event.source === window.parent && data?.type === WIDGET_SHOWN_MESSAGE && typeof data.shown === "boolean") {
      shownStore.shown = data.shown;
      shownStore.listeners.forEach((listener) => listener());
    }
  });
}

function useShown(): boolean {
  return useSyncExternalStore(shownStore.subscribe, () => shownStore.shown, () => true);
}

/** The live stream's state: whether it's open, and a count of the changes (and reconnects) it reported. */
type Live = { connected: boolean; version: number };

/**
 * Their changes as they happen (/api/widget/live, server/live.ts), read with fetch so who they are goes
 * in a header, never the URL. It reconnects after a drop, and each (re)connect counts as a change:
 * whatever happened meanwhile was missed.
 */
function useLive(projectSlug: string, auth: WidgetAuth): Live {
  const [live, setLive] = useState<Live>({ connected: false, version: 0 });
  useEffect(() => {
    const controller = new AbortController();
    const authorization = auth.token ? `Widget ${auth.token}` : auth.visitor ? `Visitor ${auth.visitor}` : null;
    const changed = (connected: boolean) => setLive((now) => ({ connected, version: now.version + 1 }));
    void (async () => {
      while (!controller.signal.aborted) {
        try {
          const response = await fetch(`/api/widget/live?project=${encodeURIComponent(projectSlug)}`, {
            headers: authorization ? { authorization } : {},
            signal: controller.signal,
          });
          if (!response.ok || !response.body) {
            throw new Error(`Live updates answered ${response.status}`);
          }
          const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
          let buffer = "";
          for (;;) {
            const { value, done } = await reader.read();
            if (done) {
              break;
            }
            buffer += value;
            for (let end = buffer.indexOf("\n\n"); end !== -1; end = buffer.indexOf("\n\n")) {
              const event = /^event: (\w+)$/m.exec(buffer.slice(0, end))?.[1];
              buffer = buffer.slice(end + 2);
              if (event === "ready" || event === "change") {
                changed(true);
              }
            }
          }
        } catch {
          // Closed, refused or offline: polling covers it until the next try.
        }
        if (controller.signal.aborted) {
          return;
        }
        setLive((now) => ({ ...now, connected: false }));
        await new Promise((resolve) => setTimeout(resolve, 5_000));
      }
    })();
    return () => controller.abort();
  }, [projectSlug, auth.token, auth.visitor]);
  return live;
}

/**
 * Runs `load` now, on each change the live stream reports, and every POLL_MS while it isn't open,
 * and returns a way to run it again (after sending). Runs can overlap: `load` gets `isLatest`, to
 * check after each await that no newer run started (and that it's still shown) before it shows what it got.
 */
function usePolling(load: (isLatest: () => boolean) => Promise<void>, live: Live) {
  const sequence = useRef(0);
  const mounted = useRef(false);
  const run = useCallback(() => {
    const mine = ++sequence.current;
    // Offline or the server failing: the next run tries again (and a send that worked isn't said to have failed).
    return load(() => mounted.current && mine === sequence.current).catch(() => {});
  }, [load]);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    void run();
  }, [run, live.version]);
  useEffect(() => {
    if (live.connected) {
      return;
    }
    const timer = setInterval(() => void run(), POLL_MS);
    return () => clearInterval(timer);
  }, [run, live.connected]);
  return run;
}

function ConversationList({
  projectSlug,
  auth,
  live,
  onOpen,
  onNew,
}: {
  projectSlug: string;
  auth: WidgetAuth;
  live: Live;
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
        // Not when Messages is only off for now: their token still works once it's back on.
        if (auth.visitor && "expired" in result) {
          visitorStore.write(projectSlug, null);
        }
        setError(result.error);
        return;
      }
      setError(undefined);
      setConversations(result.conversations);
      tellPage(result.unseen);
    },
    [projectSlug, auth],
  );
  usePolling(load, live);

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
/** No attachments here: someone new isn't anyone yet (their visitor token comes with their first message). */
const noUploads: StartUpload = async () => ({ error: "Send your first message, then attach files" });

function Composer({
  placeholder,
  label,
  email,
  send,
  upload,
}: {
  placeholder: string;
  label: string;
  email?: string;
  send: (text: string, email: string, attachments: string[]) => Promise<{ error?: string }>;
  /** Where files they attach upload (with "Attach files"); without it, there's no attaching. */
  upload?: StartUpload;
}) {
  const files = useUploads(upload ?? noUploads);
  const [text, setText] = useState("");
  const [address, setAddress] = useState(email ?? "");
  const [error, setError] = useState<string>();
  const [pending, startTransition] = useTransition();
  const submit = () =>
    startTransition(async () => {
      // Offline, or the server failing: say so by the form, and keep what they wrote.
      const sent = text;
      const result = await send(sent, address, files.ids).catch(() => ({ error: "Couldn't send it. Check your connection and try again." }));
      setError(result.error);
      if (!result.error) {
        // Only what was sent: anything typed meanwhile stays.
        setText((now) => (now === sent ? "" : now));
        files.clear();
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
          if (event.key === "Enter" && (event.metaKey || event.ctrlKey) && !pending && !files.uploading) {
            event.preventDefault();
            event.currentTarget.form?.requestSubmit();
          }
        }}
      />
      {error && <p className="text-sm text-destructive">{error}</p>}
      {upload && <UploadList uploads={files.uploads} remove={files.remove} />}
      <div className={upload ? "flex items-center justify-between gap-2" : "flex justify-end"}>
        {upload && <AttachButton attach={files.attach} />}
        <Button type="submit" disabled={pending || files.uploading}>
          {pending ? "Sending…" : "Send"}
        </Button>
      </div>
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
function FirstMessage({
  projectSlug,
  onStarted,
  onSignedIn,
}: {
  projectSlug: string;
  onStarted: (number: number) => void;
  /** It turned out they'd signed in on the portal meanwhile (no visitor token came back): the conversation is theirs. */
  onSignedIn: (number: number) => void;
}) {
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
          if (!result.visitor) {
            onSignedIn(result.number);
            return {};
          }
          onStarted(result.number);
          visitorStore.write(projectSlug, { token: result.visitor, email: email.trim() });
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
        upload={(file) => widgetUploadAttachment(projectSlug, auth, file)}
        send={async (text, email, attachments) => {
          const result = await widgetStartConversation(projectSlug, auth, text, visitorEmail === null ? undefined : email, attachments);
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

function Conversation({
  projectSlug,
  auth,
  live,
  number,
  onBack,
}: {
  projectSlug: string;
  auth: WidgetAuth;
  live: Live;
  number: number;
  onBack: () => void;
}) {
  const [opened, setOpened] = useState<Opened | null>(null);
  // Replies count as seen only while the panel is on screen; opening it again shows (and so sees) them.
  const shown = useShown();
  const [error, setError] = useState<string>();
  const load = useCallback(
    async (isLatest: () => boolean) => {
      const result = await widgetConversation(projectSlug, auth, number, shown);
      if (!isLatest()) {
        return;
      }
      if ("error" in result) {
        setError(result.error);
        return;
      }
      setError(undefined);
      setOpened(result);
      // Shown, so seen: the page's count goes down.
      const listed = await widgetConversations(projectSlug, auth);
      if (isLatest() && !("error" in listed)) {
        tellPage(listed.unseen);
      }
    },
    [projectSlug, auth, number, shown],
  );
  const reload = usePolling(load, live);

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
                  <MessageAttachments attachments={m.attachments} dropped={0} />
                </div>
              </li>
            ))}
          </ol>
          <Composer
            label="Reply"
            placeholder="Write a reply…"
            upload={(file) => widgetUploadAttachment(projectSlug, auth, file)}
            send={async (text, _email, attachments) => {
              const result = await widgetSendMessage(projectSlug, auth, number, text, attachments);
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
