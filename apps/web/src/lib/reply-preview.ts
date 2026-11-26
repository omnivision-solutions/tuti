/** A reply's translation for the composer's preview (conversations.translateReply), for the text it was made from. */
export type ReplyPreview = { for: string; text: string; language: string } | { for: string; failed: string; close?: boolean } | { for: string; asWritten: true };

/**
 * The preview to show for the reply as it's written now: one made from this text, and not in a language that's no longer
 * the customer's (they wrote in another since: a new one comes).
 */
export function previewToShow(preview: ReplyPreview | undefined, text: string | undefined, language: string | undefined) {
  return text && preview?.for === text && !("language" in preview && preview.language !== language) ? preview : undefined;
}

/**
 * A preview that's come in, in place of the one shown: a failure in place of a failed send of the same text keeps how it was
 * being sent (Send and close), so "Send in English" still closes it.
 */
export function previewAfter(shown: ReplyPreview | undefined, next: ReplyPreview): ReplyPreview {
  return "failed" in next && shown && "failed" in shown && shown.for === next.for && shown.close ? { ...next, close: shown.close } : next;
}

/**
 * Whether to ask for a preview of this text: not while its failure is shown (with "Send in English"), which asking again
 * by itself would only pay for again, nor while it's being sent (the send translates it, and its outcome is what shows);
 * once the text changes, or the preview is reset, it's asked for.
 */
export const wantsPreview = (shown: ReplyPreview | undefined, text: string | undefined, sending = false) => !!text && !sending && !(shown && "failed" in shown);
