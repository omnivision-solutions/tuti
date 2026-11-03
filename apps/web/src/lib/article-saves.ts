/**
 * The article editor after its own save went through, while it still has text typed during that save (with none, it
 * takes up the saved version afresh). Its next save is made on what its text matches:
 * - the save stored the text as sent (`merged` false): that version (`base`), the typing since being on top of it;
 * - the save merged it onto Autopilot's edits since (`merged`): the text kept hasn't got what was merged in, so it stays
 *   made on the version it was (`base` unchanged), and the saved version is shown beside it (`show`): only then does
 *   it count as seen (`seen`), putting the next save on top of it by section. Never seen unshown: a change the teammate
 *   then makes to Autopilot's part would win over it without their having seen it.
 */
export function afterOwnSave(
  base: string | null,
  saved: { revision: string | null; merged: boolean },
): { base: string | null; seen: string | null; show: boolean; own: string | null } {
  // Merged: the saved version is its own (`own`), so edits landing after it are layered on, not taken for someone's save.
  return saved.merged ? { base, seen: saved.revision, show: true, own: saved.revision } : { base: saved.revision, seen: null, show: false, own: null };
}

/**
 * Whether the editor stays as it was after a save (its version, what it had, its own): one that made no new version
 * though its text was merged (the newest as it was, which the editor's text isn't). Sent as the newest is, it has the
 * newest now: like any save stored as sent, made on that version from then on.
 */
export const staysAsItWas = (saved: { merged: boolean; newVersion: boolean } | undefined) => saved?.newVersion === false && saved.merged;
