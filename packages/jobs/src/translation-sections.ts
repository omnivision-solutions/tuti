import { type Doc, keyed, sameSection, sections } from "@tuti/content";
import { contentHash } from "@tuti/shared";

/*
 * A translated version's text by section (docs/plan.md, Languages: "Retranslating and unpublished changes"). A translation
 * keeps the source's structure, so its sections line up with the source's by position; each section of a version keeps
 * which source section it stands for (`key`, the source's section key as `behind` stores it), the hash of that source
 * section as it was when the section was translated or edited (`hash`), and whether the team owns it (`own`: an edit in the
 * draft, or one kept on publishing), which the translate job never replaces. A section the team added has no key and is
 * theirs. A section is behind when the team owns it and its source section changed since (or is gone).
 */

type Block = NonNullable<Doc["content"]>[number];

export type SectionMeta = { key: string | null; hash: string | null; own?: true };
export type Section = { blocks: Block[]; meta: SectionMeta };
export type SourceSection = { key: string; hash: string; blocks: Block[] };

/** A section's key as `behind` and `sections` store it: Postgres's JSON can't hold keyed()'s NUL, so a unit separator. */
export const behindKey = (key: string) => key.replace("\u0000", "\u001f");

/** The source text's sections, in order: their keys and hashes. */
export function sourceSections(text: Doc): SourceSection[] {
  return keyed(text).map(([key, blocks]) => ({ key: behindKey(key), hash: contentHash(JSON.stringify(blocks)), blocks }));
}

/**
 * A version's text as sections with what each stands for. Metadata that doesn't fit the text (none stored yet) is made by
 * position against `source`, none of it the team's.
 */
export function versionSections(content: Doc | null, meta: unknown, source: SourceSection[]): Section[] {
  const blocks = sections(content?.content ?? []);
  const stored = Array.isArray(meta) && meta.length === blocks.length ? (meta as SectionMeta[]) : null;
  return blocks.map((section, i) => ({ blocks: section, meta: stored?.[i] ?? { key: source[i]?.key ?? null, hash: source[i]?.hash ?? null } }));
}

export const docOfSections = (list: Section[]): Doc => ({ type: "doc", content: list.flatMap((section) => section.blocks) });
export const metaOf = (list: Section[]) => list.map((section) => section.meta);

/**
 * `current` with the translator's new text: `translated`, lined up with `source` by position. Every section of the source
 * takes its new translation, but those the team owns stay as they are, as do those it added (after the section before them);
 * a section whose source section is gone goes, unless it's the team's. `only`: just these sections take the new translation
 * (the rest stay, missing ones aren't added): a version the team writes, updating the sections it asked for.
 */
export function withTranslation(current: Section[], translated: Doc, source: SourceSection[], only?: Set<string>): Section[] {
  const fresh = sections(translated.content ?? []);
  const inSource = new Set(source.map((section) => section.key));
  const byKey = new Map<string, Section>();
  // The team's sections with no source section (added, or theirs whose source section went), after the one before them.
  const after = new Map<string | null, Section[]>();
  let previous: string | null = null;
  for (const section of current) {
    const { key } = section.meta;
    if (key !== null && inSource.has(key) && !byKey.has(key)) {
      byKey.set(key, section);
      previous = key;
    } else if (key === null || section.meta.own) {
      after.set(previous, [...(after.get(previous) ?? []), section]);
    }
  }
  const out: Section[] = [...(after.get(null) ?? [])];
  for (const [i, { key, hash }] of source.entries()) {
    const had = byKey.get(key);
    const keep = had?.meta.own || (only && !only.has(key));
    if (keep) {
      if (had) out.push(had);
    } else if (fresh[i]) {
      out.push({ blocks: fresh[i]!, meta: { key, hash } });
    }
    out.push(...(after.get(key) ?? []));
  }
  return out;
}

/**
 * The team's edit of `base` (the draft, else the published text) as sections: a section as it was keeps what it stands
 * for; a changed one is the team's, edited against the source as it is now; one past the base's is one they added.
 * ponytail: sections line up by position, so adding or taking out a heading in the middle marks the ones after it edited
 * too (kept, never lost); matching moved sections by their text is the upgrade if that matters.
 */
export function editedSections(base: Section[], edited: Doc, source: SourceSection[]): Section[] {
  const hashes = new Map(source.map((section) => [section.key, section.hash]));
  return sections(edited.content ?? []).map((blocks, i) => {
    const was = base[i];
    if (was && sameSection(was.blocks, blocks)) {
      return was;
    }
    const key = was?.meta.key ?? null;
    return { blocks, meta: { key, hash: key === null ? null : (hashes.get(key) ?? null), own: true } };
  });
}

/** The sections the team owns whose source section changed since they were translated or edited (or is gone). */
export function behindSections(list: Section[], source: SourceSection[]): string[] {
  const hashes = new Map(source.map((section) => [section.key, section.hash]));
  return list.filter(({ meta }) => meta.own && meta.key !== null && hashes.get(meta.key) !== meta.hash).map(({ meta }) => meta.key!);
}

/** A version the team writes (not kept up to date): every section is theirs, so each whose source section changed is behind. */
export const ownedByTeam = (list: Section[]): Section[] => list.map((section) => ({ ...section, meta: { ...section.meta, own: true } }));
