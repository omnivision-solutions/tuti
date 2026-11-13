"use client";

import { cn } from "cn";
import { ChevronLeftIcon, ChevronRightIcon, SquarePenIcon } from "lucide-react";
import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore, useTransition } from "react";

import { AttachButton, type StartUpload, UploadList, useUploads } from "@/components/attachment-uploads";
import { useDocsAssistant } from "@/components/docs-assistant-context";
import { EmptyState } from "@/components/empty-state";
import { MessageAttachments } from "@/components/inbox/message-attachments";
import { MessageText } from "@/components/inbox/message-text";
import { usePortalHref } from "@/components/portal-base";
import { useScrollToEnd } from "@/components/scroll-to-end";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { useWidgetSignIn } from "@/components/widget-feedback";
import { replyTime, subjectFrom, timeAgo } from "@/lib/format";
import { keepFocus } from "@/lib/keep-focus";
import { askedBy, loadOrder } from "@/lib/load-order";
import { WIDGET_LABEL, WIDGET_ROW } from "@/lib/portal-look";
import { MAX_QUESTION } from "@/lib/widget-docs";
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
 * email to write, and the panel keeps a visitor token to show them their conversations. `team`
 * (their faces and when they usually reply) heads the list and the first message. With `aiFirst` (Customize → Widget), a
 * new message goes to the docs' assistant first (useAskFirst).
 */
export function WidgetMessages({ projectSlug, portalSignedIn, team, aiFirst = false }: { projectSlug: string; portalSignedIn: boolean; team: ReactNode; aiFirst?: boolean }) {
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
  // What their list says to screen readers (loading, or that it couldn't load).
  const [listStatus, setListStatus] = useState("");
  // Until the page says who's here, nobody writes as a visitor, new or returning: someone it's about
  // to sign in would write in a conversation they'd lose sight of once it does.
  const waiting = !known && !pageAnswered;
  // A sign-in that came later, still being traded: what's on screen stays (with anything typed), but can't be sent.
  const signingIn = !known && pageSigningIn;
  // The page signing someone in or out swaps what's here for another person's (or disables it while it's
  // traded): if that took the focus from something here, it stays with Messages, not lost to the panel's
  // body. Only while the panel has the focus: someone working on the customer's page keeps it there.
  const root = useRef<HTMLDivElement>(null);
  // What has the focus in Messages; none once it's gone elsewhere (not when it's removed or disabled here).
  const lastFocused = useRef<Element | null>(null);
  useEffect(() => {
    const was = lastFocused.current;
    if (was && (!was.isConnected || was.matches(":disabled"))) {
      keepFocus(was, root.current);
    }
  }, [auth, signingIn]);
  const status = <ListStatus text={waiting ? LOADING : listStatus} />;
  const rootProps = {
    ref: root,
    tabIndex: -1,
    role: "region",
    "aria-label": "Messages",
    onFocus: (event: React.FocusEvent) => {
      lastFocused.current = event.target;
    },
    onBlur: (event: React.FocusEvent) => {
      const to = event.relatedTarget;
      if (!(to && root.current?.contains(to)) && event.target.isConnected && !event.target.matches(":disabled")) {
        lastFocused.current = null;
      }
    },
  };
  if (waiting) {
    return (
      <div {...rootProps} className="flex flex-1 flex-col gap-3 outline-none">
        {status}
        <div className="flex flex-col gap-4">
          <TeamCard team={team}>{NEW_MESSAGE_SKELETON}</TeamCard>
          <ListSkeleton />
        </div>
      </div>
    );
  }
  // The page signed someone in but their token didn't trade: say so, or they'd write as a visitor not knowing why.
  const failed = error && !known && <p className="text-sm text-destructive">{error}</p>;
  const view =
    !known && !visitor ? (
      <FirstMessage
        projectSlug={projectSlug}
        team={team}
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
        team={team}
        visitorEmail={known ? null : visitor!.email}
        opened={known && !signedInSince ? null : started}
        onNewVisitor={setStarted}
        onStatus={setListStatus}
      />
    );
  return (
    // The panel's height at least, so a conversation's reply box is at its bottom.
    <div {...rootProps} className="flex flex-1 flex-col gap-3 outline-none">
      {status}
      {failed}
      {signingIn && <p className="text-sm text-muted-foreground">Signing you in…</p>}
      {/* No box of its own: a fieldset's content doesn't grow with it, and the conversation must, to keep its reply box at the bottom. */}
      <fieldset disabled={signingIn} className="contents">
        <AiFirst value={aiFirst}>{view}</AiFirst>
      </fieldset>
    </div>
  );
}

function Messages({
  projectSlug,
  auth,
  team,
  visitorEmail,
  opened,
  onNewVisitor,
  onStatus,
}: {
  projectSlug: string;
  auth: WidgetAuth;
  team: ReactNode;
  visitorEmail: string | null;
  opened: number | null;
  /** Their token had expired, so starting a conversation made them a new visitor: open it once they are. */
  onNewVisitor: (number: number) => void;
  onStatus: (text: string) => void;
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
      team={team}
      live={live}
      onStatus={onStatus}
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
  const at = usePortalHref();
  useEffect(() => {
    const controller = new AbortController();
    const authorization = auth.token ? `Widget ${auth.token}` : auth.visitor ? `Visitor ${auth.visitor}` : null;
    const changed = (connected: boolean) => setLive((now) => ({ connected, version: now.version + 1 }));
    void (async () => {
      while (!controller.signal.aborted) {
        try {
          const response = await fetch(at(`/api/widget/live?project=${encodeURIComponent(projectSlug)}`), {
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
  }, [projectSlug, auth.token, auth.visitor, at]);
  return live;
}

/**
 * Runs `load` now, on each change the live stream reports, and every POLL_MS while it isn't open,
 * and returns a way to run it again (after sending). Each run's answer, failure included, counts only
 * while whoever it asked for is still who's here and shown (`isCurrent`: not once this view is gone, as
 * when the page signs someone else in); runs can overlap, and `isLatest` also checks no newer run started.
 * `load` checks after each await before it shows (or acts on) what it got.
 */
function usePolling(load: (isLatest: () => boolean, isCurrent: () => boolean) => Promise<void>, live: Live, auth: WidgetAuth) {
  const sequence = useRef(0);
  // Who's here while this view is (null once it's gone). Set before the first run below starts.
  const who = auth.token ?? auth.visitor ?? "portal";
  const whoNow = useRef<string | null>(null);
  useEffect(() => {
    whoNow.current = who;
    return () => {
      whoNow.current = null;
    };
  }, [who]);
  const run = useCallback(() => {
    const mine = ++sequence.current;
    const isCurrent = askedBy(() => whoNow.current);
    // Offline or the server failing: the next run tries again (and a send that worked isn't said to have failed).
    return load(() => isCurrent() && mine === sequence.current, isCurrent).catch(() => {});
  }, [load]);
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
  team,
  live,
  onStatus,
  onOpen,
  onNew,
}: {
  projectSlug: string;
  auth: WidgetAuth;
  team: ReactNode;
  live: Live;
  onStatus: (text: string) => void;
  onOpen: (number: number) => void;
  onNew: () => void;
}) {
  const [conversations, setConversations] = useState<Listed | null>(null);
  const [error, setError] = useState<string>();
  // Their list couldn't be read at all (offline, the server failing): said, with Try again, until it can.
  const [failed, setFailed] = useState(false);
  // A retry's answer still shows when a load started after it (a live update's) fails: not just the latest load's.
  const [order] = useState(loadOrder);
  const load = useCallback(
    async (_isLatest: () => boolean, isCurrent: () => boolean) => {
      const id = order.start();
      const result = await widgetConversations(projectSlug, auth).catch(() => null);
      if (!isCurrent() || !order.shows(id, !!result)) {
        return;
      }
      // Try again goes with the error once there's an answer: its focus moves to New message, which stays.
      if (result) {
        keepFocus(tryAgain.current, newMessage.current);
      }
      setFailed(!result);
      if (!result) {
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
    [projectSlug, auth, order],
  );
  const reload = usePolling(load, live, auth);
  // Trying again keeps the error and its button (not the skeleton), so the button keeps its focus.
  const [retrying, setRetrying] = useState(false);
  const tryAgain = useRef<HTMLButtonElement>(null);
  const newMessage = useRef<HTMLButtonElement>(null);
  const loading = !conversations && !error && !failed;
  const status = loading || retrying ? LOADING : failed && !conversations ? FAILED : "";
  useEffect(() => {
    onStatus(status);
    return () => onStatus("");
  }, [status, onStatus]);

  // One tree loading or not: the team's card stays mounted, so their photos don't blink as the list comes.
  return (
    <div className="flex flex-col gap-4">
      <TeamCard team={team}>
        {loading ? (
          NEW_MESSAGE_SKELETON
        ) : (
          // Where the assistant's focus goes back to when what opened it (Send, AI first) is gone.
          <Button ref={newMessage} size="lg" onClick={onNew} className="w-full" data-assistant-return>
            <SquarePenIcon data-icon="inline-start" />
            New message
          </Button>
        )}
      </TeamCard>
      {loading && <ListSkeleton />}
      {error && <p className="text-sm text-destructive">{error}</p>}
      {failed && !conversations && (
        <div className="flex flex-wrap items-center gap-2">
          <p className="text-sm text-destructive">{FAILED}</p>
          <Button
            ref={tryAgain}
            variant="outline"
            size="sm"
            disabled={retrying}
            focusableWhenDisabled
            aria-busy={retrying}
            onClick={() => {
              setRetrying(true);
              void reload().finally(() => setRetrying(false));
            }}
          >
            {retrying ? "Trying again…" : "Try again"}
          </Button>
        </div>
      )}
      {conversations?.length === 0 && <EmptyState title="No messages yet" description="Write to the team and they'll reply here." />}
      {conversations && conversations.length > 0 && (
        <div className="flex flex-col gap-1">
          <h2 className={WIDGET_LABEL}>Your conversations</h2>
          <ul className="flex flex-col divide-y" aria-label="Conversations">
            {conversations.map((c) => (
              <li key={c.number}>
                <button type="button" onClick={() => onOpen(c.number)} className={cn(WIDGET_ROW, "w-[calc(100%+1rem)]")}>
                  <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <span className={cn("truncate text-sm", c.unseen > 0 ? "font-semibold" : "font-medium")}>{c.subject}</span>
                    {/* The latest message's first line, theirs marked as such. */}
                    {c.line && <span className="truncate text-sm text-muted-foreground">{c.yours ? `You: ${c.line}` : c.line}</span>}
                    <span className="text-xs text-muted-foreground">
                      {c.closed ? "Closed" : c.replied ? "Replied" : "Waiting for a reply"} · {timeAgo(new Date(c.lastMessageAt))}
                    </span>
                  </span>
                  {c.unseen > 0 && (
                    <span className="size-2.5 shrink-0 rounded-full bg-unread">
                      <span className="sr-only">New reply</span>
                    </span>
                  )}
                  <ChevronRightIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

const LOADING = "Loading conversations…";
const FAILED = "Couldn't load your conversations.";

/**
 * What the list says to screen readers (LOADING, FAILED, or nothing). The region is put on the page empty
 * and its text written a moment later, so it's a change in a live region already there, which they announce
 * (one that arrives with its text isn't, nor one filled in the same task; nor the same words written over themselves).
 * A load quicker than that says nothing.
 */
function ListStatus({ text }: { text: string }) {
  const region = useRef<HTMLParagraphElement>(null);
  useEffect(() => {
    // Already saying it: the same loading (the page answered, then the list loads) isn't said again; a
    // repeated failure is emptied at once and said again (a retry that fails as fast as this).
    if (region.current!.textContent === text) {
      if (text === LOADING) {
        return;
      }
      region.current!.textContent = "";
    }
    const timer = setTimeout(() => {
      region.current!.textContent = text;
    }, 100);
    return () => clearTimeout(timer);
  }, [text]);
  return <p ref={region} role="status" className="sr-only" />;
}

/** The team (their faces, when they reply) atop the panel, with what to do next under them and a line below. */
function TeamCard({ team, children }: { team: ReactNode; children?: ReactNode }) {
  return (
    <div className="flex flex-col gap-4 border-b pt-2 pb-5">
      {team}
      {children}
    </div>
  );
}

/** New message's place in the team's card while the list loads. */
const NEW_MESSAGE_SKELETON = <Skeleton aria-hidden className="h-9 w-full rounded-lg" />;

/** What the conversations will look like, while they load; ListStatus says so. */
function ListSkeleton() {
  return (
    <div aria-hidden data-loading-skeleton className="flex flex-col divide-y">
      {[0, 1, 2].map((row) => (
        <div key={row} className="flex flex-col gap-1.5 py-3">
          <Skeleton className="h-4 w-2/3" />
          <Skeleton className="h-3.5 w-5/6" />
          <Skeleton className="h-3 w-1/4" />
        </div>
      ))}
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
  maxLength,
}: {
  placeholder: string;
  label: string;
  email?: string;
  maxLength?: number;
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
      const attached = files.ids;
      const result = await send(sent, address, attached).catch(() => ({ error: "Couldn't send it. Check your connection and try again." }));
      setError(result.error);
      if (!result.error) {
        // Only what was sent: anything typed meanwhile stays.
        setText((now) => (now === sent ? "" : now));
        files.sent(attached);
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
        maxLength={maxLength}
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

/** "We'll reply here, usually in a few minutes. If you've left by then, we'll email you at …": where the team's reply comes, and when. */
function replyWhere(email: string | null, ms: number | null) {
  const here = ms === null ? "We'll reply here." : `We'll reply here, usually in ${replyTime(ms)}.`;
  return email ? `${here} If you've left${ms === null ? "" : " by then"}, we'll email you at ${email}.` : here;
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
const AiFirstContext = createContext(false);
const AiFirst = ({ value, children }: { value: boolean; children: ReactNode }) => <AiFirstContext value={value}>{children}</AiFirstContext>;

/**
 * With AI first: a new message without files, short enough to be a question (MAX_QUESTION), is one for the docs'
 * assistant, which takes the panel with its answer and "Ask a person" (which starts the conversation, with the question and
 * the answer). Null otherwise, and false for a message it doesn't take: it goes to the team.
 */
function useAskFirst() {
  const assistant = useDocsAssistant();
  if (!useContext(AiFirstContext) || !assistant) {
    return null;
  }
  return (text: string, attachments: string[]) => {
    if (attachments.length > 0 || text.trim().length > MAX_QUESTION) {
      return false;
    }
    // A question of its own: a new message, not a follow-up to what the assistant answered before.
    assistant.ask(text, { fresh: true });
    return true;
  };
}

function FirstMessage({
  projectSlug,
  team,
  onStarted,
  onSignedIn,
}: {
  projectSlug: string;
  team: ReactNode;
  onStarted: (number: number) => void;
  /** It turned out they'd signed in on the portal meanwhile (no visitor token came back): the conversation is theirs. */
  onSignedIn: (number: number) => void;
}) {
  const askFirst = useAskFirst();
  const at = usePortalHref();
  return (
    <div className="flex flex-col gap-4">
      <TeamCard team={team} />
      <p className="text-sm text-muted-foreground">
        {askFirst ? "Ask anything: you'll get an answer right away, and a person if you need one." : "Leave your email so the team can get back to you."}{" "}
        <a href={at("/sign-in")} target="_blank" rel="noreferrer" className="underline underline-offset-4">
          Sign in
        </a>{" "}
        to see your past conversations.
      </p>
      <Composer
        label="Message"
        placeholder="How can we help?"
        // Asked first, the email comes with "Ask a person"; it's a question, so no longer than one.
        email={askFirst ? undefined : ""}
        maxLength={askFirst ? MAX_QUESTION : undefined}
        send={async (text, email) => {
          if (askFirst?.(text, [])) {
            return {};
          }
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
  const askFirst = useAskFirst();
  return (
    <div className="flex flex-col gap-3">
      <BackButton onBack={onBack} />
      <Composer
        label="Message"
        placeholder="How can we help?"
        email={visitorEmail ?? undefined}
        upload={(file) => widgetUploadAttachment(projectSlug, auth, file)}
        send={async (text, email, attachments) => {
          // Asked first: behind the assistant, their list, where a conversation it starts shows. The email they gave
          // (perhaps corrected) is the one Ask a person starts with.
          if (askFirst?.(text, attachments)) {
            if (visitorEmail !== null && auth.visitor) {
              visitorStore.write(projectSlug, { token: auth.visitor, email: email.trim() });
            }
            onBack();
            return {};
          }
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
  const reload = usePolling(load, live, auth);
  // The newest message in view as it opens, as messages come and as their images load (the panel
  // scrolls, not the customer's page).
  const list = useRef<HTMLOListElement>(null);
  const panel = useCallback(() => list.current?.closest("[data-widget-scroll]") ?? null, []);
  useScrollToEnd(opened?.messages.length ?? 0, panel);

  return (
    <div className="flex flex-1 flex-col gap-3">
      <BackButton onBack={onBack} />
      {error && <p className="text-sm text-destructive">{error}</p>}
      {opened && (
        <>
          {/* A subject someone wrote, in full; one made from the first message (shown in full below it) at most two lines. */}
          <h2 className={cn("font-medium break-words", opened.messages[0] && subjectFrom(opened.messages[0].body) === opened.subject && "line-clamp-2")}>
            {opened.subject}
          </h2>
          <ol ref={list} className="flex flex-col gap-2" aria-label="Messages">
            {opened.messages.map((m) => (
              <li key={m.id} className={cn("flex", !m.fromTeam && "justify-end")}>
                <div className={cn("max-w-[85%] rounded-xl border px-3 py-2", !m.fromTeam && "bg-muted")}>
                  <p className="text-xs text-muted-foreground">
                    {m.fromTeam ? (m.name ?? "The team") : "You"} · {timeAgo(new Date(m.createdAt))}
                  </p>
                  <p className="text-sm break-words whitespace-pre-wrap">
                    <MessageText text={m.body} ugc={!m.fromTeam} />
                  </p>
                  <MessageAttachments attachments={m.attachments} dropped={m.dropped} imported />
                </div>
              </li>
            ))}
          </ol>
        </>
      )}
      {/* Waiting for the team's reply, theirs the latest: where it comes, and when. A live region on the page from the
          start (empty until then), so screen readers hear it appear once they've sent a message. */}
      <p role="status" className="text-center text-sm break-words text-muted-foreground">
        {opened?.awaitingReply && opened.messages.at(-1)?.fromTeam === false ? replyWhere(opened.emailedTo, opened.replyMs) : ""}
      </p>
      {opened && (
        <>
          {/* At the bottom of the panel as the messages scroll under it (-mx-4, -mb-4 and -bottom-4: over the panel's padding). */}
          <div className="sticky -bottom-4 -mx-4 -mb-4 mt-auto border-t bg-card px-4 pt-3 pb-4">
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
          </div>
        </>
      )}
    </div>
  );
}
