/**
 * A form field that shows a stored value and follows it as the page refreshes (a teammate's save, the server's own),
 * without undoing what the person has done since.
 */

/** A field's own edit, until it matches what's stored: then it's the field left alone again, following the stored value. */
export const keptEdit = (edited: string | null, stored: string) => (edited !== null && edited.trim() === stored ? null : edited);

/** A save of this page's waiting to see its value stored (wrapped: "none" is a value too), or null when none is. */
export type Pending<T> = { value: T } | null;

/** What a save starts waiting for: only a change brings a refresh of its own. */
export const pendingAfterSave = <T>(sent: T, stored: T): Pending<T> => (sent === stored ? null : { value: sent });

/**
 * A refresh brings `stored`. That save's own refresh leaves the field as it is now (a pick made since stays) and ends
 * the wait; any other (a teammate's, or one that landed between the save and its refresh) is followed.
 */
export function onRefresh<T>(pending: Pending<T>, stored: T): { pending: Pending<T>; follow: boolean } {
  if (pending && stored === pending.value) {
    return { pending: null, follow: false };
  }
  return { pending, follow: true };
}
