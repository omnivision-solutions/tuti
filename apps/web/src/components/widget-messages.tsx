"use client";

import { cn } from "cn";
import { ChevronLeftIcon, ChevronRightIcon, MessageCircleIcon, SquarePenIcon, ThumbsDownIcon, ThumbsUpIcon } from "lucide-react";
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, useTransition } from "react";

import { AttachButton, type StartUpload, UploadList, useUploads } from "@/components/attachment-uploads";
import { AnswerSources } from "@/components/docs-answer";
import { EmptyState } from "@/components/empty-state";
import { MessageAttachments } from "@/components/inbox/message-attachments";
import { MessageText } from "@/components/inbox/message-text";
import { usePortalHref } from "@/components/portal-base";
import { useScrollToEnd } from "@/components/scroll-to-end";
import { SendError } from "@/components/send-error";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { useWidgetSignIn } from "@/components/widget-feedback";
import { replyTimeUnit, subjectFrom, timeAgo } from "@/lib/format";
import { useLocale, useTranslations } from "next-intl";
import { keepFocus } from "@/lib/keep-focus";
import { askedBy, loadOrder } from "@/lib/load-order";
import { WIDGET_LABEL, WIDGET_ROW } from "@/lib/portal-look";
import { widgetSourceHref } from "@/lib/widget-docs";
import { WIDGET_SHOWN_MESSAGE, WIDGET_UNSEEN_MESSAGES } from "@/lib/widget-messages";
import { rateDocsAnswer } from "@/server/docs-readers";
import {
  widgetAskPerson,
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
 * (their faces and when they usually reply) heads the list and the first message. With `aiFirst` (Settings → Workflows), a
 * new conversation is the AI's first (server/ai-turn.ts): its answers come in the thread, with Ask a person under them.
 */
export function WidgetMessages({ projectSlug, portalSignedIn, team, aiFirst = false }: { projectSlug: string; portalSignedIn: boolean; team: ReactNode; aiFirst?: boolean }) {
  const t = useTranslations("widget");
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
    "aria-label": t("messages"),
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
        aiFirst={aiFirst}
        onStarted={setStarted}
        onSignedIn={(number) => {
          setStarted(number);
          setSignedInSince(true);
        }}
      />
    ) : (
      // Someone else here: their own Messages, from their list. The same person signed in again (a view asking the
      // page for its token, as this one does as it opens) has a new token but keeps what's open here.
      <Messages
        key={auth.token && signedIn ? `user:${signedIn.id}` : (auth.visitor ?? "portal")}
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
      {signingIn && <p className="text-sm text-muted-foreground">{t("signingIn")}</p>}
      {/* No box of its own: a fieldset's content doesn't grow with it, and the conversation must, to keep its reply box at the bottom. */}
      <fieldset disabled={signingIn} className="contents">
        {view}
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
  const t = useTranslations("widget");
  const language = useLocale();
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
          // Where the assistant's focus goes back to when what opened it is gone.
          <Button ref={newMessage} size="lg" onClick={onNew} className="w-full" data-assistant-return>
            <SquarePenIcon data-icon="inline-start" />
            {t("newMessage")}
          </Button>
        )}
      </TeamCard>
      {loading && <ListSkeleton />}
      {error && <p lang="en" className="text-sm text-destructive">{error}</p>}
      {failed && !conversations && (
        <div className="flex flex-wrap items-center gap-2">
          <p className="text-sm text-destructive">{t(FAILED)}</p>
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
            {retrying ? t("tryingAgain") : t("tryAgainButton")}
          </Button>
        </div>
      )}
      {conversations?.length === 0 && <EmptyState title={t("noMessages")} description={t("noMessagesLine")} />}
      {conversations && conversations.length > 0 && (
        <div className="flex flex-col gap-1">
          <h2 className={WIDGET_LABEL}>{t("yourConversations")}</h2>
          <ul className="flex flex-col divide-y" aria-label={t("conversations")}>
            {conversations.map((c) => (
              <li key={c.number}>
                <button type="button" onClick={() => onOpen(c.number)} className={cn(WIDGET_ROW, "w-[calc(100%+1rem)]")}>
                  <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <span className={cn("truncate text-sm", c.unseen > 0 ? "font-semibold" : "font-medium")}>{c.subject}</span>
                    {/* The latest message's first line, theirs marked as such. */}
                    {c.line && <span className="truncate text-sm text-muted-foreground">{c.yours ? t("youLine", { line: c.line }) : c.line}</span>}
                    <span className="text-xs text-muted-foreground">
                      {c.closed ? t("closed") : c.replied ? t("replied") : t("waiting")} · {timeAgo(new Date(c.lastMessageAt), new Date(), language)}
                    </span>
                  </span>
                  {c.unseen > 0 && (
                    <span className="size-2.5 shrink-0 rounded-full bg-unread">
                      <span className="sr-only">{t("newReply")}</span>
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

/** What the list says (ListStatus), as `widget` messages' keys: translated where they're said. */
const LOADING = "loadingConversations";
const FAILED = "couldntLoadConversations";

/**
 * What the list says to screen readers (LOADING, FAILED, or nothing). The region is put on the page empty
 * and its text written a moment later, so it's a change in a live region already there, which they announce
 * (one that arrives with its text isn't, nor one filled in the same task; nor the same words written over themselves).
 * A load quicker than that says nothing.
 */
function ListStatus({ text }: { text: string }) {
  const t = useTranslations("widget");
  const region = useRef<HTMLParagraphElement>(null);
  useEffect(() => {
    // Already saying it: the same loading (the page answered, then the list loads) isn't said again; a
    // repeated failure is emptied at once and said again (a retry that fails as fast as this).
    const said = text ? t(text as typeof LOADING | typeof FAILED) : "";
    if (region.current!.textContent === said) {
      if (text === LOADING) {
        return;
      }
      region.current!.textContent = "";
    }
    const timer = setTimeout(() => {
      region.current!.textContent = said;
    }, 100);
    return () => clearTimeout(timer);
  }, [text, t]);
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
  const t = useTranslations("widget");
  // No attaching before the first message: what it says, in the panel's language.
  const noUploads: StartUpload = async () => ({ error: t("attachAfterFirst") });
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
      const result = await send(sent, address, attached).catch(() => ({ error: t("couldntSend") }));
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
          aria-label={t("yourEmail")}
          placeholder={t("yourEmail")}
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
      {error && <SendError error={error} />}
      {upload && <UploadList uploads={files.uploads} remove={files.remove} />}
      <div className={upload ? "flex items-center justify-between gap-2" : "flex justify-end"}>
        {upload && <AttachButton attach={files.attach} />}
        <Button type="submit" disabled={pending || files.uploading}>
          {pending ? t("sending") : t("send")}
        </Button>
      </div>
    </form>
  );
}

/** "We'll reply here, usually in a few minutes. If you've left by then, we'll email you at …": where the team's reply comes, and when. */
function replyWhere(email: string | null, ms: number | null, t: ReturnType<typeof useTranslations<"widget">>) {
  const here = ms === null ? t("replyHere") : t("replyHereIn", { when: t("replyWhen", replyTimeUnit(ms)) });
  return email ? `${here} ${ms === null ? t("emailIfLeft", { email }) : t("emailIfLeftByThen", { email })}` : here;
}

function BackButton({ onBack }: { onBack: () => void }) {
  const t = useTranslations("widget");
  return (
    <Button variant="ghost" size="sm" onClick={onBack} className="-ml-2 self-start">
      <ChevronLeftIcon />
      {t("messages")}
    </Button>
  );
}

/** Someone signed out, writing for the first time: their email, so the team can reply once they've left. */
function FirstMessage({
  projectSlug,
  team,
  onStarted,
  onSignedIn,
  aiFirst,
}: {
  projectSlug: string;
  team: ReactNode;
  aiFirst: boolean;
  onStarted: (number: number) => void;
  /** It turned out they'd signed in on the portal meanwhile (no visitor token came back): the conversation is theirs. */
  onSignedIn: (number: number) => void;
}) {
  const t = useTranslations("widget");
  const at = usePortalHref();
  return (
    <div className="flex flex-col gap-4">
      <TeamCard team={team} />
      <p className="text-sm text-muted-foreground">
        {aiFirst ? t("aiFirstLine") : t("leaveEmail")}{" "}
        {t.rich("signInPast", {
          link: (chunks) => (
            <a href={at("/sign-in")} target="_blank" rel="noreferrer" className="underline underline-offset-4">
              {chunks}
            </a>
          ),
        })}
      </p>
      <Composer
        label={t("message")}
        placeholder={t("howCanWeHelp")}
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
  const t = useTranslations("widget");
  return (
    <div className="flex flex-col gap-3">
      <BackButton onBack={onBack} />
      <Composer
        label={t("message")}
        placeholder={t("howCanWeHelp")}
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
  const t = useTranslations("widget");
  const language = useLocale();
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
  // Where the focus goes once Ask a person is gone: the line saying where the team's reply comes.
  const status = useRef<HTMLParagraphElement>(null);
  const [asking, startAsking] = useTransition();
  const [askError, setAskError] = useState<string>();
  const askPerson = (button: HTMLElement) =>
    startAsking(async () => {
      const result = await widgetAskPerson(projectSlug, auth, number).catch(() => ({ error: t("couldntSend") }));
      setAskError("error" in result ? result.error : undefined);
      if (!("error" in result)) {
        await reload();
        keepFocus(button, status.current);
      }
    });

  return (
    <div className="flex flex-1 flex-col gap-3">
      <BackButton onBack={onBack} />
      {error && <p lang="en" className="text-sm text-destructive">{error}</p>}
      {opened && (
        <>
          {/* A subject someone wrote, in full; one made from the first message (shown in full below it) at most two lines. */}
          <h2 className={cn("font-medium break-words", opened.messages[0] && subjectFrom(opened.messages[0].body) === opened.subject && "line-clamp-2")}>
            {opened.subject}
          </h2>
          {/* New messages are read out as they come (the AI's answer, the team's reply). */}
          <ol ref={list} className="flex flex-col gap-2" aria-label={t("messages")} aria-live="polite" aria-relevant="additions">
            {opened.messages.map((m) => (
              <li key={m.id} className={cn("flex", !m.fromTeam && "justify-end")}>
                <div className={cn("max-w-[85%] rounded-xl border px-3 py-2", !m.fromTeam && "bg-muted")}>
                  <p className="text-xs text-muted-foreground">
                    {m.ai ? t("ai") : m.fromTeam ? (m.name ?? t("theTeam")) : t("you")} · {timeAgo(new Date(m.createdAt), new Date(), language)}
                  </p>
                  <p lang={m.language ?? undefined} className="text-sm break-words whitespace-pre-wrap">
                    <MessageText text={m.body} ugc={!m.fromTeam} />
                  </p>
                  {m.original !== null && (
                    // A translated reply: what the team wrote, a click away (docs/plan.md L22).
                    <details
                      className="group mt-1 text-xs text-muted-foreground"
                      // Opened on the latest reply, its original would be under the reply box: brought into view.
                      onToggle={(event) => event.currentTarget.open && event.currentTarget.lastElementChild?.scrollIntoView({ block: "nearest" })}
                    >
                      <summary className="w-fit cursor-pointer list-none font-medium underline underline-offset-2 [&::-webkit-details-marker]:hidden">
                        <span className="group-open:hidden">{t("showOriginal")}</span>
                        <span className="hidden group-open:inline">{t("hideOriginal")}</span>
                      </summary>
                      <p lang={opened.teamLanguage} className="mt-1 scroll-mb-40 text-sm break-words whitespace-pre-wrap text-foreground">
                        <MessageText text={m.original} ugc={false} />
                      </p>
                    </details>
                  )}
                  <MessageAttachments
                    attachments={m.attachments}
                    dropped={m.dropped}
                    imported
                    words={{ attachments: t("attachments"), dropped: t("attachmentsDropped", { count: m.dropped }) }}
                  />
                  {m.answer && <AiAnswerFooter projectSlug={projectSlug} answer={m.answer} />}
                </div>
              </li>
            ))}
          </ol>
        </>
      )}
      {/* While the AI has it and isn't writing: under its latest answer (or their message it said nothing to, a "hi"). */}
      {opened?.askPerson && !opened.answering && (
        <div className="flex flex-col items-start gap-1">
          <Button variant="outline" size="sm" disabled={asking} focusableWhenDisabled onClick={(event) => askPerson(event.currentTarget)}>
            <MessageCircleIcon data-icon="inline-start" />
            {t("askPerson")}
          </Button>
          {askError && (
            // The server's own words stay English (L5); the panel's own failure is in its language.
            <SendError error={askError} alert />
          )}
        </div>
      )}
      {/* Waiting for the team's reply, theirs the latest: where it comes, and when. A live region on the page from the
          start (empty until then), so screen readers hear it appear once they've sent a message. */}
      <p ref={status} tabIndex={-1} role="status" className="text-center text-sm break-words text-muted-foreground outline-none">
        {opened?.answering
          ? t("answering")
          : opened?.awaitingReply && !opened.withAi && opened.messages.findLast((m) => !m.ai)?.fromTeam === false
            ? replyWhere(opened.emailedTo, opened.replyMs, t)
            : ""}
      </p>
      {opened && (
        <>
          {/* At the bottom of the panel as the messages scroll under it (-mx-4, -mb-4 and -bottom-4: over the panel's padding). */}
          <div className="sticky -bottom-4 -mx-4 -mb-4 mt-auto border-t bg-card px-4 pt-3 pb-4">
            <Composer
              label={t("reply")}
              placeholder={t("writeReply")}
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

/** Under the AI's answer in the thread: its sources, and thumbs up or down. */
function AiAnswerFooter({ projectSlug, answer }: { projectSlug: string; answer: NonNullable<Opened["messages"][number]["answer"]> }) {
  const t = useTranslations("widget");
  const at = usePortalHref();
  const [rated, setRated] = useState(answer.helpful);
  const [pending, startTransition] = useTransition();
  const rate = (helpful: boolean) =>
    startTransition(async () => {
      // Offline, or the server failing: as it was, to try again.
      const result = await rateDocsAnswer(projectSlug, answer.questionId, helpful).catch(() => ({ error: "failed" }));
      if (!result.error) {
        setRated(helpful);
      }
    });
  return (
    <div className="mt-2 flex flex-col gap-2">
      {answer.sources.length > 0 && (
        // An article opens in the panel's Help center, an API reference's operation on its page.
        <AnswerSources
          sources={answer.sources}
          href={(slug) => {
            const href = widgetSourceHref(slug);
            return href === null ? null : at(href);
          }}
        />
      )}
      {/* The thumbs stay (pressed once rated, and can be changed), so the focus stays on them. */}
      <div className="flex flex-wrap items-center gap-1 text-sm text-muted-foreground">
        <Button variant="ghost" size="icon-sm" aria-label={t("helpful")} aria-pressed={rated === true} disabled={pending} focusableWhenDisabled onClick={() => rate(true)}>
          <ThumbsUpIcon className={cn(rated === true && "fill-current")} />
        </Button>
        <Button variant="ghost" size="icon-sm" aria-label={t("notHelpful")} aria-pressed={rated === false} disabled={pending} focusableWhenDisabled onClick={() => rate(false)}>
          <ThumbsDownIcon className={cn(rated === false && "fill-current")} />
        </Button>
        <span role="status">{rated !== null && t("thanks")}</span>
      </div>
    </div>
  );
}
