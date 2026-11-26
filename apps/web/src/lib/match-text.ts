/**
 * Text as off-limits topics and the spam filter's phrases are matched: lowercase, accents dropped, and everything but
 * letters and numbers as single spaces, so a match is case-insensitive and on word boundaries.
 */
export const matchText = (text: string) =>
  text
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
