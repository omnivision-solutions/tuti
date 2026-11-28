"use client";

import { LanguagesIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { createContext, type ReactNode, useContext, useEffect, useRef, useState, useTransition } from "react";
import { toast } from "sonner";

import { MessageText } from "@/components/inbox/message-text";
import { Button } from "@/components/ui/button";
import { nativeLanguageName } from "@/lib/language-name";
import { errorMessage, useTRPCClient } from "@/components/trpc";

/** The line under a translated message: muted, and on the team's green bubble in its text colour (the bubble's own rule). */
const LINE = "inbox-translation mt-1 flex flex-wrap items-center gap-x-1 text-xs leading-4.5 text-muted-foreground [&>svg]:size-3.25 [&>svg]:flex-none";
const TOGGLE = "cursor-pointer font-medium underline underline-offset-2";
/** How long "Translating…" shows after Try again, at most. */
const RETRY_SHOWN_MS = 60_000;

/**
 * The conversation's messages Try again queued again: it re-queues every customer message whose translation failed, so
 * each says "Translating…", not only the one clicked.
 */
const RetriedTranslations = createContext<{ retried: ReadonlySet<string>; markRetried: () => void }>({ retried: new Set(), markRetried: () => {} });

/**
 * Around a conversation's messages: `failed`, the ids of those whose translation failed as the page was rendered (what
 * Try again re-queues). "Translating…" shows on them for a minute at most once Try again has queued them.
 */
export function TranslationRetries({ failed, children }: { failed: string[]; children: ReactNode }) {
  const [retried, setRetried] = useState<ReadonlySet<string>>(new Set());
  // ponytail: a minute, not the job's own word; a retry the job skips (nothing to translate after all) leaves no trace to
  // wait on. A translation or failure later still shows through the live refresh.
  useEffect(() => {
    if (retried.size === 0) {
      return;
    }
    const timer = setTimeout(() => setRetried(new Set()), RETRY_SHOWN_MS);
    return () => clearTimeout(timer);
  }, [retried]);
  return <RetriedTranslations.Provider value={{ retried, markRetried: () => setRetried(new Set(failed)) }}>{children}</RetriedTranslations.Provider>;
}

/**
 * Which line a message has under it: its translation's, its failure's, "Translating…" once Try again has queued it
 * (until the live refresh brings the result), or none.
 */
function translationLine({ teamText, error, fromTeam, retried }: { teamText: string | null; error: string | null; fromTeam: boolean; retried: boolean }) {
  if (teamText !== null) {
    return "translated";
  }
  if (fromTeam) {
    return null;
  }
  return error ? "failed" : retried ? "translating" : null;
}

/**
 * A message's text where the conversation is translated (docs/plan.md L22). The customer's message: its translation into
 * the team's language, "Translated from Deutsch · Show original" under it; one whose translation failed shows as written,
 * with why and Try again. The team's reply: as they wrote it, "Sent in Deutsch · Show translation" (what the customer got).
 * Always one wrapper around the text, so the text (and the keyboard's focus on it) stays as the line under it changes.
 */
export function MessageTranslation({
  id,
  body,
  teamText,
  language,
  error,
  fromTeam,
  canRetry,
  projectSlug,
  number,
}: {
  /** The message's id (Try again's "Translating…" goes by it). */
  id: string;
  /** The customer's side: what they wrote, or the translation they got. */
  body: string;
  /** The team's side: the customer's message translated, or the reply as the team wrote it. */
  teamText: string | null;
  language: string | null;
  /** Why the customer's message couldn't be translated. */
  error: string | null;
  fromTeam: boolean;
  /** Try again can run: the project translates conversations and the server has AI. */
  canRetry: boolean;
  projectSlug: string;
  number: number;
}) {
  const [other, setOther] = useState(false);
  const [retrying, startRetry] = useTransition();
  const trpc = useTRPCClient();
  const router = useRouter();
  // Queued again (this one or another's Try again): "Translating…" until the result is in.
  const { retried, markRetried } = useContext(RetriedTranslations);
  // Where the keyboard's focus goes once Try again's line is gone.
  const textRef = useRef<HTMLParagraphElement>(null);
  const bodyShown = teamText === null || other;
  const line = translationLine({ teamText, error, fromTeam, retried: retried.has(id) || retrying });
  const name = language && nativeLanguageName(language);
  return (
    <div>
      {/* `body` is in `language` (the customer's) where it's what's shown. */}
      <p ref={textRef} tabIndex={-1} lang={bodyShown ? (language ?? undefined) : undefined} className="text-sm leading-normal break-words whitespace-pre-wrap outline-none">
        <MessageText text={teamText !== null && !other ? teamText : body} ugc={!fromTeam} />
      </p>
      {line === "translated" && (
        // Always with its line: the original is a click away, its language named where it's known.
        <p className={LINE}>
          <LanguagesIcon aria-hidden />
          <span>{fromTeam ? (name ? `Sent in ${name}` : "Sent translated") : name ? `Translated from ${name}` : "Translated"} ·</span>
          <button type="button" className={TOGGLE} onClick={() => setOther(!other)}>
            {other ? (fromTeam ? "Show yours" : "Show translation") : fromTeam ? "Show translation" : "Show original"}
          </button>
        </p>
      )}
      {line === "translating" && (
        <p className={LINE} role="status">
          <LanguagesIcon aria-hidden />
          Translating…
        </p>
      )}
      {line === "failed" && (
        <p className={LINE}>
          <LanguagesIcon aria-hidden />
          {/* Why, in words: a phone can't hover for it. */}
          <span>
            {/* Some reasons say it already ("Couldn't queue its translation"). */}
            {error?.startsWith("Couldn't") ? error : `Couldn't translate it: ${error}`}
            {canRetry && " ·"}
          </span>
          {canRetry && (
            <Button
              type="button"
              variant="link"
              // Inline in the line's text, as the toggle beside a translation is.
              className="h-auto p-0 text-xs font-medium text-current underline underline-offset-2"
              disabled={retrying}
              // It keeps the keyboard's focus while it works.
              focusableWhenDisabled
              onClick={() =>
                startRetry(async () => {
                  const result = await trpc.conversations.retryTranslation.mutate({ project: projectSlug, number }).then(
                    () => ({ error: null }),
                    (error: unknown) => ({ error: errorMessage(error) }),
                  );
                  if (result.error) {
                    toast.error(result.error);
                  } else {
                    router.refresh();
                    markRetried();
                    textRef.current?.focus();
                  }
                })
              }
            >
              {retrying ? "Translating…" : "Try again"}
            </Button>
          )}
        </p>
      )}
    </div>
  );
}
