"use client";

import { LanguagesIcon } from "lucide-react";
import { useRef, useState, useTransition } from "react";
import { toast } from "sonner";

import { MessageText } from "@/components/inbox/message-text";
import { nativeLanguageName } from "@/lib/language-name";
import { retryTranslation } from "@/server/inbox";

/** The line under a translated message: muted, and on the team's green bubble in its text colour (the bubble's own rule). */
const LINE = "inbox-translation mt-1 flex flex-wrap items-center gap-x-1 text-xs leading-4.5 text-muted-foreground [&>svg]:size-3.25 [&>svg]:flex-none";
const TOGGLE = "cursor-pointer font-medium underline underline-offset-2";

/**
 * Which line a message has under it: its translation's, its failure's, "Translating…" once Try again has queued it
 * (until the live refresh brings the result), or none.
 */
export function translationLine({ teamText, error, fromTeam, retried }: { teamText: string | null; error: string | null; fromTeam: boolean; retried: boolean }) {
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
  body,
  teamText,
  language,
  error,
  fromTeam,
  canRetry,
  projectSlug,
  number,
}: {
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
  // Queued again: "Translating…" until the result is in.
  const [retried, setRetried] = useState(false);
  // Where the keyboard's focus goes once Try again's line is gone.
  const textRef = useRef<HTMLParagraphElement>(null);
  const bodyShown = teamText === null || other;
  const line = translationLine({ teamText, error, fromTeam, retried: retried || retrying });
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
            <button
              type="button"
              className={TOGGLE}
              // Not disabled: it keeps the keyboard's focus while it works.
              aria-disabled={retrying || undefined}
              onClick={() =>
                !retrying &&
                startRetry(async () => {
                  const result = await retryTranslation(projectSlug, number).catch(() => ({ error: "Couldn't ask for it again: try again in a moment" }));
                  if (result.error) {
                    toast.error(result.error);
                  } else {
                    setRetried(true);
                    textRef.current?.focus();
                  }
                })
              }
            >
              {retrying ? "Translating…" : "Try again"}
            </button>
          )}
        </p>
      )}
    </div>
  );
}
