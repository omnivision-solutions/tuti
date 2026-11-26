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
 * A message's text where the conversation is translated (docs/plan.md L22). The customer's message: its translation into
 * the team's language, "Translated from Deutsch · Show original" under it; one whose translation failed shows as written,
 * with Try again. The team's reply: as they wrote it, "Sent in Deutsch · Show translation" (what the customer got).
 */
export function MessageTranslation({
  body,
  teamText,
  language,
  error,
  fromTeam,
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
  projectSlug: string;
  number: number;
}) {
  const [other, setOther] = useState(false);
  const [retrying, startRetry] = useTransition();
  // Where the keyboard's focus goes once Try again's line is gone.
  const textRef = useRef<HTMLParagraphElement>(null);
  const bodyShown = teamText === null || other;
  const text = (
    // `body` is in `language` (the customer's) where it's what's shown.
    <p ref={textRef} tabIndex={-1} lang={bodyShown ? (language ?? undefined) : undefined} className="text-sm leading-normal break-words whitespace-pre-wrap outline-none">
      <MessageText text={teamText !== null && !other ? teamText : body} ugc={!fromTeam} />
    </p>
  );
  // Always with its line: the original is a click away, its language named where it's known.
  if (teamText !== null) {
    const name = language && nativeLanguageName(language);
    return (
      <div>
        {text}
        <p className={LINE}>
          <LanguagesIcon aria-hidden />
          <span>{fromTeam ? (name ? `Sent in ${name}` : "Sent translated") : name ? `Translated from ${name}` : "Translated"} ·</span>
          <button type="button" className={TOGGLE} onClick={() => setOther(!other)}>
            {other ? (fromTeam ? "Show yours" : "Show translation") : fromTeam ? "Show translation" : "Show original"}
          </button>
        </p>
      </div>
    );
  }
  if (!fromTeam && error) {
    return (
      <div>
        {text}
        <p className={LINE}>
          <LanguagesIcon aria-hidden />
          <span title={error}>Couldn&apos;t translate it ·</span>
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
                  textRef.current?.focus();
                }
              })
            }
          >
            {retrying ? "Translating…" : "Try again"}
          </button>
          <span className="sr-only">{error}</span>
        </p>
      </div>
    );
  }
  return text;
}
