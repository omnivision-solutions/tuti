/**
 * The new part of an email reply: what's left once the quoted message, signatures and Outlook's
 * header blocks are cut off (docs/plan.md, Support inbox, "Receiving email").
 *
 * Ported from OpenDesk (https://github.com/useopendesk/opendesk, internal/email/quote.go and
 * parse.go), Copyright 2026 Mindroot Ltd, licensed under the Apache License 2.0
 * (http://www.apache.org/licenses/LICENSE-2.0). Changes: TypeScript; plain text only (mail parsing
 * gives a text version of HTML mail, where the HTML markers' quotes show as these lines); lines
 * longer than 2,000 characters aren't tested, as JavaScript's regexes backtrack where Go's don't.
 */

/** "On <date>, <name> wrote:" (any character, line breaks too, in the gaps) in English, French, German, Spanish, Dutch, Italian, Portuguese and Danish/Norwegian. */
const ON_WROTE =
  /^\s*(on\s[\s\S]{1,300}\swrote\s?:|le\s[\s\S]{1,300}\sa\s[ée]crit\s?:|am\s[\s\S]{1,300}\sschrieb[\s\S]{0,100}:|el\s[\s\S]{1,300}\sescribi[óo]\s?:|op\s[\s\S]{1,300}\sschreef[\s\S]{0,60}:|il\s[\s\S]{1,300}\sha\sscritto\s?:|em\s[\s\S]{1,300}\sescreveu\s?:|den\s[\s\S]{1,300}\sskrev[\s\S]{0,60}:)\s*$/i;
const ORIGINAL_MESSAGE = /^\s*-{2,}\s*(original message|ursprüngliche nachricht|message d'origine|mensaje original|messaggio originale)\s*-{2,}/i;
const UNDERSCORES = /^\s*_{20,}\s*$/;
const HEADER_FROM = /^\s*\*?(from|von|de|da|van)\s?:\*?\s+\S/i;
const HEADER_SENT = /^\s*\*?(sent|date|gesendet|datum|envoyé|enviado|inviato|verzonden)\s?:\*?\s/i;
const MOBILE_SIGNATURE =
  /^\s*(sent from my (iphone|ipad|android|mobile|phone|samsung|galaxy|blackberry)|sent from (outlook|mail) for (ios|android|iphone)|get outlook for (ios|android)|sent from yahoo mail)\b/i;
/** A forward: kept whole, as the forwarded message is what they're sending. */
export const FORWARD_SUBJECT = /^\s*(fwd?|fw|tr|wg|rv|enc)\s*:/i;
/** "Re: ", "AW: ", "Fwd: " and the like, as many as there are. */
export const REPLY_PREFIXES = /^\s*((re|aw|sv|antw|vs|ref|odp|fwd?|fw|tr|wg|rv|enc)\s*(\[\d+\])?\s*:\s*)+/i;

const ATTRIBUTION_STARTS = ["on ", "le ", "am ", "el ", "op ", "il ", "em ", "den "];
const MAX_LINE = 2000;

const test = (pattern: RegExp, line: string) => line.length <= MAX_LINE && pattern.test(line);

/** The reply without what it quotes; the whole text when cutting would leave nothing, or for a forward (`subject`). */
export function stripQuotes(text: string, subject = ""): { text: string; stripped: boolean } {
  const whole = text.replace(/\r\n?/g, "\n");
  if (FORWARD_SUBJECT.test(subject)) {
    return { text: whole.trim(), stripped: false };
  }
  const lines = whole.split("\n");
  const trimmedLine = (i: number) => (lines[i] ?? "").replace(/ /g, " ").trim();
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]!.replace(/[ \t ]+$/, "");
    const trimmed = trimmedLine(i);
    const next = trimmedLine(i + 1);
    const cut =
      raw === "--" ||
      (raw.startsWith("--") && trimmed === "--") ||
      test(ON_WROTE, trimmed) ||
      (ATTRIBUTION_STARTS.some((start) => trimmed.toLowerCase().startsWith(start)) && test(ON_WROTE, `${trimmed} ${next}`)) ||
      test(ORIGINAL_MESSAGE, trimmed) ||
      (UNDERSCORES.test(trimmed) && [1, 2, 3].some((d) => test(HEADER_FROM, trimmedLine(i + d)))) ||
      (test(HEADER_FROM, trimmed) && [1, 2, 3, 4, 5].some((d) => test(HEADER_SENT, trimmedLine(i + d)))) ||
      test(MOBILE_SIGNATURE, trimmed) ||
      (trimmed.startsWith(">") && lines.slice(i).every((line) => line.trim() === "" || line.trim().startsWith(">")));
    if (cut) {
      const kept = lines.slice(0, i).join("\n").trim();
      return kept ? { text: kept, stripped: true } : { text: whole.trim(), stripped: false };
    }
  }
  return { text: whole.trim(), stripped: false };
}
