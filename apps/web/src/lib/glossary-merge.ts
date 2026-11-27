import type { GlossaryTermInput } from "@/server/glossary";

/** A term as the Glossary editor holds it. */
export type MergeRow = GlossaryTermInput & { key: string; /** Changed by a teammate while this was edited (a refused save merged it in). */ meanwhile?: Meanwhile };
type Meanwhile = "Added meanwhile" | "Changed meanwhile" | "Removed meanwhile";

const words = (term: GlossaryTermInput) => JSON.stringify(Object.entries(term.translations).filter(([, word]) => word).sort());
const same = (a: GlossaryTermInput, b: GlossaryTermInput) => a.keep === b.keep && words(a) === words(b);

/**
 * A save refused as a teammate saved meanwhile (docs/design.md: what was typed kept, the newest version beside it): the
 * teammate's changes from `before` to `theirs` put into `rows`, marked. A term they added is added; one they changed takes
 * their word in each language not edited here, what was typed here staying, and their Never translated only if neither it
 * nor any word was changed here (else the words typed would be hidden, and not saved); one they removed stays, for the
 * team to remove or keep; one added both here and there gets their words in the languages left empty here.
 */
export function mergeMeanwhile(rows: MergeRow[], before: GlossaryTermInput[], theirs: GlossaryTermInput[], newKey: () => string): MergeRow[] {
  const byTerm = (list: GlossaryTermInput[]) => new Map(list.map((term) => [term.term.trim().toLowerCase(), term]));
  const old = byTerm(before);
  const now = byTerm(theirs);
  const merged: MergeRow[] = rows.map((row) => {
    const name = row.term.trim().toLowerCase();
    const was = old.get(name);
    const is = now.get(name);
    if (was && !is) return { ...row, meanwhile: "Removed meanwhile" };
    if (!was && is && !same(row, is)) {
      const empty = Object.entries(is.translations).filter(([code]) => !(row.translations[code] ?? "").trim());
      return { ...row, translations: { ...row.translations, ...Object.fromEntries(empty) }, meanwhile: "Changed meanwhile" };
    }
    if (was && is && !same(was, is)) {
      const codes = new Set([...Object.keys(was.translations), ...Object.keys(is.translations), ...Object.keys(row.translations)]);
      const edited = (code: string) => (row.translations[code] ?? "").trim() !== (was.translations[code] ?? "");
      const word = (code: string) => (edited(code) ? row.translations[code] : is.translations[code]) ?? "";
      const translations = Object.fromEntries([...codes].map((code) => [code, word(code)]).filter(([, text]) => text));
      const keep = row.keep === was.keep && ![...codes].some(edited) ? is.keep : row.keep;
      return { ...row, keep, translations, meanwhile: "Changed meanwhile" };
    }
    return row;
  });
  const here = new Set(rows.map((row) => row.term.trim().toLowerCase()));
  for (const [name, term] of now) {
    if (!old.has(name) && !here.has(name)) merged.push({ ...term, key: newKey(), meanwhile: "Added meanwhile" });
  }
  return merged;
}
