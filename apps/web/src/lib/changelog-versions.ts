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

/** The changelog version form's key: its language alone, so a new read (its own save's included) never remounts it over typing. */
export const versionFormKey = (view: { code: string }) => `version:${view.code}`;
