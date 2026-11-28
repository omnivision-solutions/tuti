/** A reply's translation for the composer's preview (conversations.translateReply), for the text it was made from. */
export type ReplyPreview =
  | { for: string; text: string; language: string }
  /** `language`: the one it was to be in, where known. */
  | { for: string; failed: string; language?: string; close?: boolean }
  | { for: string; asWritten: true };

/**
 * The preview to show for the reply as it's written now: one made from this text, and not in (or failed in) a language
 * that's no longer the customer's (they wrote in another since: a new one comes). A failure of no known language is
 * dropped once the customer's is known, as it may not have been theirs.
 */
export function previewToShow(preview: ReplyPreview | undefined, text: string | undefined, language: string | undefined) {
  if (!text || preview?.for !== text) {
    return undefined;
  }
  if ("asWritten" in preview) {
    return preview;
  }
  return preview.language === language || (preview.language === undefined && language === undefined) ? preview : undefined;
}

/**
 * A preview that's come in, in place of the one shown: a failure in place of a failed send of the same text keeps how it was
 * being sent (Send and close), so "Send in English" still closes it.
 */
export function previewAfter(shown: ReplyPreview | undefined, next: ReplyPreview): ReplyPreview {
  return "failed" in next && shown && "failed" in shown && shown.for === next.for && shown.close ? { ...next, close: shown.close } : next;
}

/**
 * Whether to ask for a preview of this text: only on the Reply tab (a draft left there while a note is written isn't
 * previewed unseen), and only where none is shown for it (translated, as written, or failed with
 * "Send in English"): asking again would only pay for the same translation again. Nor while it's being sent (the send
 * translates it, and its outcome is what shows). Once the text or the customer's language changes, or the preview is
 * reset, it's asked for.
 */
export const wantsPreview = (shown: ReplyPreview | undefined, text: string | undefined, sending = false, onReply = true) =>
  !!text && onReply && !sending && !shown;

/** A reply that couldn't be translated, as the composer says why: without the API's advice (it has "Send in English"). */
export const withoutAdvice = (message: string) => message.replace(/ Send it untranslated.*$/, "");
