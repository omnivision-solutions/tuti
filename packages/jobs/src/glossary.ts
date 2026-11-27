import { type GlossaryTerm, termsUsed } from "@tuti/content";
import { type Prisma, prisma } from "@tuti/db";
import { contentHash } from "@tuti/shared";

/**
 * The glossary (docs/plan.md, Languages, L12): the team's terms, each never translated (`keep`) or translated one way per
 * language (`translations`, by code; a language without one: the model decides). Every translation is sent the terms its
 * text uses, and checked for them after (@tuti/content translateDoc).
 */
export type Glossary = { term: string; keep: boolean; translations: Record<string, string> }[];

/** A project's glossary, by term. */
export async function projectGlossary(projectId: string, db: Prisma.TransactionClient | typeof prisma = prisma): Promise<Glossary> {
  const rows = await db.glossaryTerm.findMany({ where: { projectId }, orderBy: { term: "asc" }, select: { term: true, keep: true, translations: true } });
  return rows.map(({ term, keep, translations }) => ({ term, keep, translations: translations as Record<string, string> }));
}

/** The glossary as it goes into one language: a term kept as it is, or its word there; one the model decides there is left out. */
export function glossaryIn(glossary: Glossary, language: string): GlossaryTerm[] {
  return glossary.flatMap(({ term, keep, translations }) => (keep ? [{ term }] : translations[language] ? [{ term, translation: translations[language] }] : []));
}

/**
 * What a text's translation into a language is made with: the terms of the glossary there the text uses (termsUsed), and
 * their hash (null for none, as a version made before the glossary has), so a version can tell a term it uses changed.
 */
export function glossaryFor(glossary: Glossary, language: string, text: string): { terms: GlossaryTerm[]; hash: string | null } {
  const terms = termsUsed(text, glossaryIn(glossary, language)).sort((a, b) => a.term.localeCompare(b.term));
  return { terms, hash: terms.length > 0 ? contentHash(JSON.stringify(terms.map(({ term, translation }) => [term, translation ?? null]))) : null };
}

/** Why a section of a version the team writes is behind after a glossary term it uses changed. */
export const glossaryChangedFor = (term: string) => `The glossary changed for ${term}.`;

/**
 * The terms whose treatment in `language` differs between two glossaries: added, removed, kept or translated otherwise, or
 * written in another case (the team changed what they want written; the prompt says it as written, and glossaryFor's hash
 * changes with it).
 */
export function changedIn(before: Glossary, after: Glossary, language: string): GlossaryTerm[] {
  const key = (term: string) => term.toLowerCase();
  const [was, now] = [new Map(glossaryIn(before, language).map((t) => [key(t.term), t])), new Map(glossaryIn(after, language).map((t) => [key(t.term), t]))];
  const terms = new Set([...was.keys(), ...now.keys()]);
  return [...terms].flatMap((term) => {
    const [a, b] = [was.get(term), now.get(term)];
    return a?.translation === b?.translation && a?.term === b?.term ? [] : [b ?? a!];
  });
}
