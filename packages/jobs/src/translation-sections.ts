import { canonicalBlocks, type Doc, keyed, sameSection, sections } from "@tuti/content";
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
export type SectionMeta = {
  key: string | null;
  hash: string | null;
  own?: true;
  kept?: true;
  /** The hash of the section's own text as written with this: text written another way since (the previous release's job, during a deploy, rewrote it) isn't what this says. */
  text?: string;
  /**
   * The team's paragraph at the top standing in for the source's intro: how many of its first blocks are the intro's
   * translation (0: none yet). Taking a new translation replaces only those, the team's paragraph staying after them.
   */
  standIn?: number;
  /**
   * Other source sections it stands for too: a section of the team's with no heading, standing for a source section the
   * source moved later, merged into the one at the top (two with no heading in a row read back as one). Counted as there.
   */
  also?: string[];
};

/** A section's own text as a hash (see SectionMeta.text). */
const textHash = (blocks: Block[]) => contentHash(canonicalBlocks(blocks));
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
  // A section whose text isn't what its metadata was written with (rewritten without it: the previous release's job during a
  // deploy) is a translation of the source as it is, by position, none of it the team's.
  return blocks.map((section, i) => {
    const known = stored?.[i];
    return { blocks: section, meta: known && (known.text === undefined || known.text === textHash(section)) ? known : { key: source[i]?.key ?? null, hash: source[i]?.hash ?? null } };
  });
}

export const docOfSections = (list: Section[]): Doc => ({ type: "doc", content: list.flatMap((section) => section.blocks) });
export const metaOf = (list: Section[]) => list.map((section) => ({ ...section.meta, text: textHash(section.blocks) }));

/**
 * `current` with the translator's new text: `translated`, lined up with `source` by position. Every section of the source
 * takes its new translation, but those the team owns stay as they are, as do those it added (after the section before them);
 * a section whose source section is gone goes, unless it's the team's. `only`: just these sections take the new translation
 * (the rest stay, missing ones aren't added): a version the team writes, updating the sections it asked for. `published`:
 * the published text of a version kept up to date, where the team's edits (not those it kept) give way where their source
 * section changed; in a draft they never do. `removed`: source sections the team took out of it, which aren't put back.
 * `asked`: sections the team asked to translate again (Update those sections; `only` by default): they take the new
 * translation whoever owns them, kept ones included; the team's other sections stay as they are.
 */
export function withTranslation(
  current: Section[],
  translated: Doc,
  source: SourceSection[],
  { only, published = false, removed, asked = only }: { only?: Set<string>; published?: boolean; removed?: Set<string>; asked?: Set<string> } = {},
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
      for (const other of section.meta.also ?? []) if (inSource.has(other) && !byKey.has(other)) byKey.set(other, section);
      previous = key;
    } else if (key === null || (section.meta.own && (!published || section.meta.kept) && !asked?.has(key)) || (only && !only.has(key))) {
      // (Published on a version kept up to date, the team's edit whose source section went goes too, unless they kept it.)
      // (A version the team writes keeps its sections whose source went, but where it asked for them.)
      after.set(previous, [...(after.get(previous) ?? []), section]);
    } else if (section.meta.standIn !== undefined && key !== null && !inSource.has(key)) {
      // Standing in for an intro the source no longer has, and going (not kept, not left as it is): the intro's translation
      // goes, the team's own paragraph stays, theirs (as it was before the intro came).
      const own = section.blocks.slice(section.meta.standIn);
      if (own.length > 0) after.set(previous, [...(after.get(previous) ?? []), { blocks: own, meta: { key: null, hash: null, own: true } }]);
    }
  }
  const out: Section[] = [...(after.get(null) ?? [])];
  // Each section once, though it stands for more than one source section (`also`).
  const placed = new Set<Section>();
  for (const [i, { key, hash }] of source.entries()) {
    const found = byKey.get(key);
    // Standing for this one too (`also`): kept where it is, unless this one is asked for, which then comes in by itself.
    if (found && found.meta.key !== key) {
      if (asked?.has(key) && fresh[i]) out.push({ blocks: fresh[i]!, meta: { key, hash } });
      out.push(...(after.get(key) ?? []));
      continue;
    }
    const had = found;
    const theirs = !asked?.has(key) && !!had?.meta.own && (!published || !!had.meta.kept || had.meta.hash === hash);
    // Not there because the team took it out (and didn't ask for it back, or took it out after asking): left out.
    const keep = theirs || (only && !only.has(key)) || (!had && !!removed?.has(key) && !asked?.has(key));
    if (keep) {
      if (had && !placed.has(had)) {
        out.push(had);
        placed.add(had);
      }
    } else if (fresh[i]) {
      out.push(standingIn(had, fresh[i]!, { key, hash }));
    }
    out.push(...(after.get(key) ?? []));
  }
  // Only a text's first section has no heading: one after a heading would read back as part of the section before it (and the
  // text would split into fewer sections than it says it has). So a section with none goes first: the source's intro, or a
  // section of the team's that has none though its source section has a heading (one the source moved later, say), the
  // source's intro ahead of the team's.
  const headless = (section: Section | undefined) => !!section && section.blocks[0]?.type !== "heading";
  const introKey = source[0] && source[0].blocks[0]?.type !== "heading" ? source[0].key : null;
  const tops = out.filter((section) => headless(section)).sort((a, b) => Number(b.meta.key === introKey) - Number(a.meta.key === introKey));
  if (tops.length > 0 && tops.some((section, i) => out[i] !== section)) {
    out.splice(0, out.length, ...tops, ...out.filter((section) => !headless(section)));
  }
  // Two in a row would read back as one. The team's, at the top, stands for the source's intro then: still theirs, and behind it
  // (the source's intro is new to it).
  if (headless(out[0]) && headless(out[1])) {
    const introKey = source[0]!.key;
    const [first, second] = [out[0]!, out[1]!];
    const [sources, theirs] = first.meta.key === introKey ? [first, second] : [second, first];
    // The source sections the team's stood for besides the intro: still stood for, not missing.
    const also = [...new Set([...(sources.meta.also ?? []), ...(theirs.meta.also ?? []), ...(theirs.meta.key !== null && theirs.meta.key !== introKey ? [theirs.meta.key] : [])])];
    // Asked for (Update those sections, on a version the team writes): its new translation, and the team's own paragraph after
    // it (it asked to add the intro, not to drop its text). Else the team's, kept (so a later run keeps it too).
    out.splice(
      0,
      2,
      asked?.has(introKey)
        ? { blocks: [...sources.blocks, ...theirs.blocks], meta: { key: introKey, hash: sources.meta.hash, own: true, standIn: sources.blocks.length, ...(also.length > 0 && { also }) } }
        : { blocks: theirs.blocks, meta: { key: introKey, hash: null, own: true, kept: true, standIn: 0, ...(also.length > 0 && { also }) } },
    );
  }
  return out;
}

/**
 * A section taking its new translation (`blocks`, for the source section `meta`): the team's paragraph standing in for the
 * source's intro (`had`'s `standIn`) stays after it, theirs; anything else is the translation alone.
 */
export function standingIn(had: Section | undefined, blocks: Block[], meta: { key: string; hash: string | null }): Section {
  const standIn = had?.meta.standIn;
  return standIn === undefined ? { blocks, meta } : { blocks: [...blocks, ...had!.blocks.slice(standIn)], meta: { ...meta, own: true, standIn: blocks.length } };
}

/** A section's text under its heading ("" for none), to know it again with its heading reworded. */
const bodyOf = (blocks: Block[]) => {
  const rest = blocks[0]?.type === "heading" ? blocks.slice(1) : blocks;
  return rest.length > 0 ? canonicalBlocks(rest) : "";
};

/** A section's heading text ("" for one with none), to know it again after the text around it moved. */
// Compared in one key order (canonicalBlocks): a section read back from Postgres has its keys in another than one sent.
const headingOf = (blocks: Block[]) => (blocks[0]?.type === "heading" ? canonicalBlocks(blocks[0].content ?? []) : "");

/**
 * The team's edit of `base` (the draft, else the published text) as sections. Each edited section is known again as the base
 * section it was: one with the same text, else the same heading, else the same text under it (the intro: the base's intro);
 * between those, the ones left
 * over pair in order where as many are left on each side; one that is none of them is one the team added. A section as it was keeps what it stands for. A changed one is the team's,
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
  // Else the same text under its heading (the heading reworded).
  matched.forEach((was, n) => {
    if (was) return;
    const body = bodyOf(blocks[n]!);
    matched[n] = body ? take(base.findIndex((other, i) => !used.has(i) && bodyOf(other.blocks) === body)) : undefined;
  });
  // The intro (the one section with no heading, before the first) is the base's intro, however it was edited.
  if (blocks[0] && !headingOf(blocks[0]) && !matched[0] && base[0] && !headingOf(base[0].blocks)) {
    matched[0] = take(0);
  }
  // Those matched are fixed points: between two of them (and before the first, after the last), sections left over pair with
  // the base's left over there in order, but only as many on each side (one rewritten in place). Else they're ones the team
  // added, and the base's ones it took out: no text lost, though one rewritten and moved counts as replaced.
  const anchors = [
    { n: -1, i: -1 },
    ...matched.flatMap((was, n) => (was ? [{ n, i: base.indexOf(was) }] : [])),
    { n: blocks.length, i: base.length },
  ];
  for (const [k, from] of anchors.slice(0, -1).entries()) {
    const to = anchors[k + 1]!;
    const free = base.map((_, i) => i).filter((i) => i > from.i && i < to.i && !used.has(i));
    const left = blocks.map((_, n) => n).filter((n) => n > from.n && n < to.n && !matched[n]);
    if (left.length === free.length) {
      left.forEach((n, f) => (matched[n] = take(free[f]!)));
    }
  }
  const out = blocks.map((section, i): Section => {
    const was = matched[i];
    if (was && sameSection(was.blocks, section)) {
      return was;
    }
    if (was) {
      const behindUnseen = automatic && !was.meta.own;
      // Kept (publishing with `keep`) stays kept: an edit updates the section, it doesn't take back never replacing it.
      const hash = behindUnseen || was.meta.key === null ? was.meta.hash : (hashes.get(was.meta.key) ?? null);
      // Standing in for the source's intro while the intro's translation at its top is as it was (the team edited their own
      // paragraph after it); what else it stands for, as it was.
      const standIn = was.meta.standIn;
      const introKept = standIn !== undefined && canonicalBlocks(was.blocks.slice(0, standIn)) === canonicalBlocks(section.slice(0, standIn));
      return {
        blocks: section,
        meta: {
          key: was.meta.key,
          hash,
          own: true,
          ...(was.meta.kept && { kept: true as const }),
          ...(introKept && { standIn }),
          ...(was.meta.also && { also: was.meta.also }),
        },
      };
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
  const has = new Set(list.flatMap(({ meta }) => [meta.key, ...(meta.also ?? [])]));
  return [...stale, ...(missing ? source.filter(({ key }) => !has.has(key) && !removed?.has(key)).map(({ key }) => key) : [])];
}

/** A version the team writes (not kept up to date): every section is theirs, so each whose source section changed is behind. */
export const ownedByTeam = (list: Section[]): Section[] => list.map((section) => ({ ...section, meta: { ...section.meta, own: true } }));
