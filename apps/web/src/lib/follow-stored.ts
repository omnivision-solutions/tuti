/**
 * A form field that shows a stored value and follows it as the page refreshes (a teammate's save, the server's own),
 * without undoing what the person has done since.
 */

/** A field's own edit, until it matches what's stored: then it's the field left alone again, following the stored value. */
export const keptEdit = (edited: string | null, stored: string) => (edited !== null && edited.trim() === stored ? null : edited);

/**
 * A save of this page's waiting to see its value stored (wrapped: "none" is a value too), and whether the person has
 * picked something since it was sent; or null when none is waiting.
 */
export type Pending<T> = { value: T; picked: boolean } | null;

/** What a save starts waiting for: only a change brings a refresh of its own. */
export const pendingAfterSave = <T>(sent: T, stored: T): Pending<T> => (sent === stored ? null : { value: sent, picked: false });

/** The person picked something while a save was waiting: its own refresh mustn't undo that. */
export const pickedSince = <T>(pending: Pending<T>): Pending<T> => pending && { ...pending, picked: true };

/**
 * A refresh brings `stored`. That save's own refresh ends the wait and is followed, unless the person picked something
 * since (that pick stays). Any other (a teammate's, landing between the save and its own) is followed, and replaces
 * that pick: then the save's own refresh, stored after it, is followed too.
 */
export function onRefresh<T>(pending: Pending<T>, stored: T): { pending: Pending<T>; follow: boolean } {
  if (pending && stored === pending.value) {
    return { pending: null, follow: !pending.picked };
  }
  return { pending: pending && { ...pending, picked: false }, follow: true };
}
