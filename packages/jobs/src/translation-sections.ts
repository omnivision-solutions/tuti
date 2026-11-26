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

/**
 * `own`: the team's edit. In a draft it always stays; published on a version kept up to date, it stays until its source
 * section changes (publishing the source again replaces edits only in the sections it touches), unless `kept` (the team
 * chose to keep it over a newer translation), when it stays for good, behind, until Update those sections.
 */
export type SectionMeta = { key: string | null; hash: string | null; own?: true; kept?: true };
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
 * (the rest stay, missing ones aren't added): a version the team writes, updating the sections it asked for. `published`:
 * the published text of a version kept up to date, where the team's edits (not those it kept) give way where their source
 * section changed; in a draft they never do. `removed`: source sections the team took out of it, which aren't put back.
 */
export function withTranslation(
  current: Section[],
  translated: Doc,
  source: SourceSection[],
  { only, published = false, removed }: { only?: Set<string>; published?: boolean; removed?: Set<string> } = {},
): Section[] {
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
    } else if (key === null || (section.meta.own && (!published || section.meta.kept)) || (only && !only.has(key))) {
      // (Published on a version kept up to date, the team's edit whose source section went goes too, unless they kept it.)
      // (A version the team writes keeps its sections whose source went, but where it asked for them.)
      after.set(previous, [...(after.get(previous) ?? []), section]);
    }
  }
  const out: Section[] = [...(after.get(null) ?? [])];
  for (const [i, { key, hash }] of source.entries()) {
    const had = byKey.get(key);
    const theirs = !!had?.meta.own && (!published || !!had.meta.kept || had.meta.hash === hash);
    // Not there because the team took it out (and didn't ask for it back): left out.
    const keep = theirs || (only && !only.has(key)) || (!had && !!removed?.has(key) && !only?.has(key));
    if (keep) {
      if (had) out.push(had);
    } else if (fresh[i]) {
      out.push({ blocks: fresh[i]!, meta: { key, hash } });
    }
    out.push(...(after.get(key) ?? []));
  }
  return out;
}

/** A section's heading text ("" for one with none), to know it again after the text around it moved. */
const headingOf = (blocks: Block[]) => (blocks[0]?.type === "heading" ? JSON.stringify(blocks[0].content ?? []) : "");

/**
 * The team's edit of `base` (the draft, else the published text) as sections. Each edited section is known again as the base
 * section it was: one with the same text, else the same heading; between those, the ones left over pair in order; one that
 * is none of them is one the team added. A section as it was keeps what it stands for. A changed one is the team's,
 * and counts as updated against the source as it is now, unless it wasn't shown as behind when it was edited (a section of a
 * version kept up to date that the team didn't own, maybe translated from older source text): that one keeps the hash it had,
 * so an edit of an old translation is still behind. `removed`: the base's sections the edit took out.
 * ponytail: matching by text and heading, then position; a section both moved and rewritten (heading too) counts as added
 * and its old one as removed.
 */
export function editedSections(base: Section[], edited: Doc, source: SourceSection[], { automatic = true }: { automatic?: boolean } = {}): { sections: Section[]; removed: string[] } {
  const hashes = new Map(source.map((section) => [section.key, section.hash]));
  const blocks = sections(edited.content ?? []);
  const used = new Set<number>();
  const take = (i: number) => (i === -1 || used.has(i) ? undefined : (used.add(i), base[i]));
  const matched = blocks.map((section) => {
    const same = base.findIndex((was, i) => !used.has(i) && sameSection(was.blocks, section));
    return same === -1 ? undefined : take(same);
  });
  matched.forEach((was, n) => {
    if (was) return;
    const heading = headingOf(blocks[n]!);
    matched[n] = heading ? take(base.findIndex((other, i) => !used.has(i) && headingOf(other.blocks) === heading)) : undefined;
  });
  // Those matched are fixed points: between two of them (and before the first, after the last), the sections left over pair
  // with the base's left over there, in order, however many were added or taken out elsewhere. (An intro, with no heading,
  // pairs with the base's.)
  const anchors = [
    { n: -1, i: -1 },
    ...matched.flatMap((was, n) => (was ? [{ n, i: base.indexOf(was) }] : [])),
    { n: blocks.length, i: base.length },
  ];
  for (const [k, from] of anchors.slice(0, -1).entries()) {
    const to = anchors[k + 1]!;
    const free = base.map((_, i) => i).filter((i) => i > from.i && i < to.i && !used.has(i));
    for (let n = from.n + 1, f = 0; n < to.n && f < free.length; n++) {
      if (!matched[n]) matched[n] = take(free[f++]!);
    }
  }
  const out = blocks.map((section, i): Section => {
    const was = matched[i];
    if (was && sameSection(was.blocks, section)) {
      return was;
    }
    if (was) {
      const behindUnseen = automatic && !was.meta.own;
      return { blocks: section, meta: { key: was.meta.key, hash: behindUnseen || was.meta.key === null ? was.meta.hash : (hashes.get(was.meta.key) ?? null), own: true } };
    }
    // Nothing to line up with yet (written before its first translation): the source's section in its place, as it is now.
    const key = base.length === 0 ? (source[i]?.key ?? null) : null;
    return { blocks: section, meta: { key, hash: key === null ? null : (hashes.get(key) ?? null), own: true } };
  });
  const removed = base.filter((_, i) => !used.has(i)).flatMap(({ meta }) => (meta.key === null ? [] : [meta.key]));
  return { sections: out, removed };
}

/**
 * The sections the team owns whose source section changed since they were translated or edited (or is gone); with `missing`,
 * also the source's sections the version doesn't have (a version the team writes: English added or renamed one), but those
 * the team took out (`removed`).
 */
export function behindSections(list: Section[], source: SourceSection[], { missing = false, removed }: { missing?: boolean; removed?: Set<string> } = {}): string[] {
  const hashes = new Map(source.map((section) => [section.key, section.hash]));
  const stale = list.filter(({ meta }) => meta.own && meta.key !== null && hashes.get(meta.key) !== meta.hash).map(({ meta }) => meta.key!);
  const has = new Set(list.map(({ meta }) => meta.key));
  return [...stale, ...(missing ? source.filter(({ key }) => !has.has(key) && !removed?.has(key)).map(({ key }) => key) : [])];
}

/** A version the team writes (not kept up to date): every section is theirs, so each whose source section changed is behind. */
export const ownedByTeam = (list: Section[]): Section[] => list.map((section) => ({ ...section, meta: { ...section.meta, own: true } }));
