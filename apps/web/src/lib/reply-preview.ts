/** A reply's translation for the composer's preview (conversations.translateReply), for the text it was made from. */
export type ReplyPreview =
  | { for: string; text: string; language: string }
  /** `language`: the one it was to be in, where known (a send refused before the page knew it's translated isn't). */
  | { for: string; failed: string; language?: string; close?: boolean }
  | { for: string; asWritten: true };

/**
 * The preview to show for the reply as it's written now: one made from this text, and not in (or failed in) a language
 * that's no longer the customer's (they wrote in another since: a new one comes).
 */
export function previewToShow(preview: ReplyPreview | undefined, text: string | undefined, language: string | undefined) {
  return text && preview?.for === text && !("language" in preview && preview.language !== undefined && preview.language !== language) ? preview : undefined;
}

/**
 * A preview that's come in, in place of the one shown: a failure in place of a failed send of the same text keeps how it was
 * being sent (Send and close), so "Send in English" still closes it.
 */
export function previewAfter(shown: ReplyPreview | undefined, next: ReplyPreview): ReplyPreview {
  return "failed" in next && shown && "failed" in shown && shown.for === next.for && shown.close ? { ...next, close: shown.close } : next;
}

/**
 * Whether to ask for a preview of this text: only where none is shown for it (translated, as written, or failed with
 * "Send in English"): asking again would only pay for the same translation again. Nor while it's being sent (the send
 * translates it, and its outcome is what shows). Once the text or the customer's language changes, or the preview is
 * reset, it's asked for.
 */
export const wantsPreview = (shown: ReplyPreview | undefined, text: string | undefined, sending = false) => !!text && !sending && !shown;
