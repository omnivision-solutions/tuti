/**
 * The new part of an email reply: what's left once the quoted message, signatures and Outlook's
 * header blocks are cut off (docs/plan.md, Support inbox, "Receiving email"), and Featurebase's quotes and footer in
 * the emails it imports.
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
/**
 * Featurebase's attribution in the emails it sends: "<name> (<email>) wrote on <date>, <time>:", the date and time in
 * the reader's locale (9/30/2026, 1:47:14 PM; 30/9/2026, 1:47:14 p. m.; 2026. 9. 30. 오후 1:47:14): a date of three
 * numbers, then a time, with a short word for the half of the day before or after it.
 */
const WROTE_ON =
  /^\S.{0,200}\s\((mailto:)?[^\s()@]+@[^\s()]+\)\s+wrote on\s+\d{1,4}[./-]\s?\d{1,2}[./-]\s?\d{1,4}\.?,?\s+([^\s\d:]{1,4}\s+)?\d{1,2}:\d{2}(:\d{2})?(\s?[^\s\d:]{1,4}){0,2}\s*:$/i;
/** The footer of Featurebase's emails, its link's address after the words: what follows is theirs. */
const FEATUREBASE_FOOTER = /^powered by\b.{0,40}\(https?:\/\/(www\.)?featurebase\.app\b[^)]*\)$/i;
const ORIGINAL_MESSAGE = /^\s*-{2,}\s*(original message|ursprüngliche nachricht|message d'origine|mensaje original|messaggio originale)\s*-{2,}/i;
const UNDERSCORES = /^\s*_{20,}\s*$/;
const HEADER_FROM = /^\s*\*?(from|von|de|da|van)\s?:\*?\s+\S/i;
const HEADER_SENT = /^\s*\*?(sent|date|gesendet|datum|envoyé|enviado|inviato|verzonden)\s?:\*?\s/i;
const MOBILE_SIGNATURE =
  /^\s*(sent from my (iphone|ipad|android|mobile|phone|samsung|galaxy|blackberry)|sent from (outlook|mail) for (ios|android|iphone)|get outlook for (ios|android)|sent from yahoo mail|yahoo mail: search, organi[sz]e, conquer)\b/i;
/** A forward: kept whole, as the forwarded message is what they're sending. */
export const FORWARD_SUBJECT = /^\s*(fwd?|fw|tr|wg|rv|enc)\s*:/i;
/** "Re: ", "AW: ", "Fwd: " and the like, as many as there are. */
export const REPLY_PREFIXES = /^\s*((re|aw|sv|antw|vs|ref|odp|fwd?|fw|tr|wg|rv|enc)\s*(\[\d+\])?\s*:\s*)+/i;

const ATTRIBUTION_STARTS = ["on ", "le ", "am ", "el ", "op ", "il ", "em ", "den "];
const MAX_LINE = 2000;
/** How far into a message its quote is looked for: past this, it's the message's own text (cut much shorter anyway). */
export const MAX_SCAN = 200_000;

const test = (pattern: RegExp, line: string) => line.length <= MAX_LINE && pattern.test(line);

/** The reply without what it quotes; the whole text when cutting would leave nothing, or for a forward (`subject`). */
export function stripQuotes(text: string, subject = ""): { text: string; stripped: boolean } {
  const whole = text.replace(/\r\n?/g, "\n");
  if (FORWARD_SUBJECT.test(subject)) {
    return { text: whole.trim(), stripped: false };
  }
  const lines = whole.slice(0, MAX_SCAN).split("\n");
  // quotedFrom[i]: every line from i on is blank or quoted, worked out once from the end; past a cut,
  // what follows isn't known to be.
  const quotedFrom = Array<boolean>(lines.length + 1).fill(true);
  quotedFrom[lines.length] = whole.length <= MAX_SCAN;
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!.trim();
    quotedFrom[i] = quotedFrom[i + 1]! && (line === "" || line.startsWith(">"));
  }
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
      test(WROTE_ON, trimmed) ||
      test(FEATUREBASE_FOOTER, trimmed) ||
      test(ORIGINAL_MESSAGE, trimmed) ||
      (UNDERSCORES.test(trimmed) && [1, 2, 3].some((d) => test(HEADER_FROM, trimmedLine(i + d)))) ||
      (test(HEADER_FROM, trimmed) && [1, 2, 3, 4, 5].some((d) => test(HEADER_SENT, trimmedLine(i + d)))) ||
      test(MOBILE_SIGNATURE, trimmed) ||
      (trimmed.startsWith(">") && quotedFrom[i]!);
    if (cut) {
      const kept = lines.slice(0, i).join("\n").trim();
      return kept ? { text: kept, stripped: true } : { text: whole.trim(), stripped: false };
    }
  }
  return { text: whole.trim(), stripped: false };
}
