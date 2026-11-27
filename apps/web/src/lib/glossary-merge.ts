import type { GlossaryTermInput } from "@/server/glossary";

/** A term as the Glossary editor holds it. */
export type MergeRow = GlossaryTermInput & {
  key: string;
  /** Changed by a teammate while this was edited (a refused save merged it in). */
  meanwhile?: Meanwhile;
  /** Their word, by language, where both changed it ("" where they left it to the model, NEVER where they made the term Never translated): shown under the word typed here. */
  theirs?: Record<string, string>;
};
type Meanwhile = "Added meanwhile" | "Changed meanwhile" | "Removed meanwhile";
/** In `theirs`: they made the term Never translated. */
export const NEVER = "Never translated";

/**
 * A list of terms as one string, whatever order its terms and their languages are in (the server's, or the page's after a
 * merge): what the editor compares to tell whether there's anything to save. Parses back to the list.
 */
export const glossaryKey = (list: GlossaryTermInput[]) =>
  JSON.stringify(
    list
      .map(({ term, keep, translations }) => ({ term, keep, translations: Object.fromEntries(Object.entries(translations).sort(([a], [b]) => (a < b ? -1 : 1))) }))
      .sort((a, b) => (a.term < b.term ? -1 : a.term > b.term ? 1 : 0)),
  );

const words = (term: GlossaryTermInput) => JSON.stringify(Object.entries(term.translations).filter(([, word]) => word).sort());
const same = (a: GlossaryTermInput, b: GlossaryTermInput) => a.keep === b.keep && words(a) === words(b);

/**
 * A save refused as a teammate saved meanwhile (docs/design.md: what was typed kept, the newest version beside it): the
 * teammate's changes from `before` to `theirs` put into `rows`, marked. A term they added is added; one they changed takes
 * their word in each language not edited here, what was typed here staying, and their Never translated only if neither it
 * nor any word was changed here (else the words typed would be hidden, and not saved); one they removed goes, unless it
 * was edited here (then it stays, for the
 * team to remove or keep; one added both here and there gets their words in the languages left empty here; one they
 * changed that was removed (or renamed) here comes back, for the team to decide again.
 */
export function mergeMeanwhile(rows: MergeRow[], before: GlossaryTermInput[], theirs: GlossaryTermInput[], newKey: () => string): MergeRow[] {
  const byTerm = (list: GlossaryTermInput[]) => new Map(list.map((term) => [term.term.trim().toLowerCase(), term]));
  const old = byTerm(before);
  const now = byTerm(theirs);
  const merged: MergeRow[] = rows.flatMap((row): MergeRow[] => {
    const name = row.term.trim().toLowerCase();
    const was = old.get(name);
    const is = now.get(name);
    if (was && !is) return row.term.trim() === was.term && same(row, was) ? [] : [{ ...row, meanwhile: "Removed meanwhile" }];
    if (!was && is && !same(row, is)) {
      const empty = Object.entries(is.translations).filter(([code]) => !(row.translations[code] ?? "").trim());
      const differ = Object.entries(is.translations).filter(([code, word]) => (row.translations[code] ?? "").trim() && row.translations[code]!.trim() !== word);
      return [{ ...row, translations: { ...row.translations, ...Object.fromEntries(empty) }, meanwhile: "Changed meanwhile", ...(differ.length > 0 && { theirs: Object.fromEntries(differ) }) }];
    }
    if (was && is && !same(was, is)) {
      const codes = new Set([...Object.keys(was.translations), ...Object.keys(is.translations), ...Object.keys(row.translations)]);
      const edited = (code: string) => (row.translations[code] ?? "").trim() !== (was.translations[code] ?? "");
      const word = (code: string) => (edited(code) ? row.translations[code] : is.translations[code]) ?? "";
      const translations = Object.fromEntries([...codes].map((code) => [code, word(code)]).filter(([, text]) => text));
      const keep = row.keep === was.keep && ![...codes].some(edited) ? is.keep : row.keep;
      // Changed on both sides, differently: what was typed stays, theirs shown beside it, for the team to choose.
      const both = [...codes].filter((code) => edited(code) && (is.translations[code] ?? "") !== (was.translations[code] ?? "") && (is.translations[code] ?? "") !== (row.translations[code] ?? "").trim());
      return [{ ...row, keep, translations, meanwhile: "Changed meanwhile", ...(both.length > 0 && { theirs: Object.fromEntries(both.map((code) => [code, is.keep && !row.keep ? NEVER : (is.translations[code] ?? "")])) }) }];
    }
    return [row];
  });
  const here = new Set(rows.map((row) => row.term.trim().toLowerCase()));
  for (const [name, term] of now) {
    if (here.has(name)) continue;
    const was = old.get(name);
    if (!was) merged.push({ ...term, key: newKey(), meanwhile: "Added meanwhile" });
    else if (!same(was, term)) merged.push({ ...term, key: newKey(), meanwhile: "Changed meanwhile" });
  }
  return merged;
}
