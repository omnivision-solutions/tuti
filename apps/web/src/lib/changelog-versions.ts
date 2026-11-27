/** Where a changelog entry's version in another language stands, for its editor's language pill and sidebar (docs/plan.md L16). */
export type VersionState = "default" | "current" | "written" | "translating" | "waiting" | "behind" | "setting" | "unwritten";

export type VersionRow = { automatic: boolean; publishedAt: Date | null; sourceHash: string | null; error: string | null; behind: unknown; retranslate: number; retranslated: number };

/** Why a version kept up to date waits when the server can't translate (no AI set up): nothing records an error then. */
export const NO_AI_WAITING = "translating isn't set up on this server";

/**
 * A version's state against the entry's text as it is (`hash`, translationSource's): made from it (translated, or the
 * team's), on its way, unable to be translated (an error, or `aiOn` false), behind (made from other text), or marked behind
 * by the product setting changing since (`setting`); none yet: not written.
 */
/**
 * An article version's, from its read (`behind`: why sections are behind, articles.getTranslation's, if any): behind by its
 * sections, not by the whole text's hash, which writing it doesn't record and an edit kept on a version kept up to date
 * leaves old. Otherwise as an entry's.
 */
export function articleVersionState(version: VersionRow | undefined, hash: string, aiOn: boolean, behind: "source" | "setting" | null): VersionState {
  // Every section behind for the product setting's reason alone: that, not the default language, changed.
  const why = behind === "setting" ? "setting" : "behind";
  if (!version) {
    return "unwritten";
  }
  if (version.automatic) {
    // On its way or failing first; then the team's edits kept behind; else translated (or on its way) by the hash.
    // The stored `behind` isn't read here: `behind` (from the read) says it, the draft's sections too. Left in, a mark the
    // job keeps for a draft's edit would read as translating for good.
    const unmarked = { ...version, behind: {} };
    if (version.error || version.retranslate !== version.retranslated) {
      return versionState(unmarked, hash, aiOn);
    }
    return behind ? why : versionState(unmarked, hash, aiOn);
  }
  if (!version.publishedAt) {
    return "unwritten";
  }
  return behind ? why : "written";
}

export function versionState(version: VersionRow | undefined, hash: string, aiOn: boolean): VersionState {
  if (!version) {
    return "unwritten";
  }
  const marked = Object.keys((version.behind as object | null) ?? {}).length > 0;
  // Kept up to date with a Retranslate not answered yet (turned back on over the team's text), or failing: never up to date.
  if (version.automatic && (version.error || version.retranslate !== version.retranslated)) {
    return version.error || !aiOn ? "waiting" : "translating";
  }
  if (version.publishedAt && version.sourceHash === hash && !marked) {
    return version.automatic ? "current" : "written";
  }
  if (version.automatic) {
    return version.error || !aiOn ? "waiting" : "translating";
  }
  if (!version.publishedAt) {
    return "unwritten";
  }
  return version.sourceHash === hash ? "setting" : "behind";
}

/** A changelog version editor's key (ChangelogVersionEditor): its language, so what's typed in it is kept across reads. */
/** A section's name from its key (behindKey's: its heading, a unit separator, which one of that heading it is). */
export function sectionName(key: string) {
  const [head, n] = key.split("\u001f");
  const name = head || "Introduction";
  return n && n !== "0" ? `${name} (${Number(n) + 1})` : name;
}

export const versionFormKey = (view: { code: string }) => `version:${view.code}`;

/**
 * Its form's key: the language and the text shown, so each read with new text mounts the form afresh, through the editor's
 * own checks (text it can't read stays read-only, its images' addresses); the editor carries what's typed across it.
 */
export const versionTextKey = (view: { code: string; title: string; content: unknown }) => JSON.stringify([view.code, view.title, view.content]);
