/** A Verify all, as much of it as the dialog's choice needs. */
type Run = { id: string; state: "running" | "done" | "stopped" };

/**
 * The run Verify all's dialog keeps showing as the page's latest catches up with it: one started from it, or seen running
 * while it's open, till it closes. Closed, it keeps none, so it opens on what's there then (a run going on, or the next one's
 * cost and Verify).
 */
export function watchedRun<R extends Run>(open: boolean, latest: R | null, watching: R | null): R | null {
  if (!open) {
    return null;
  }
  return latest?.state === "running" && watching?.id !== latest.id ? latest : watching;
}

/** What the dialog shows: the latest run while it's going or watched (its newest state), else the one watched; null for the next one's cost. */
export const shownRun = <R extends Run>(latest: R | null, watching: R | null): R | null =>
  latest && (latest.state === "running" || latest.id === watching?.id) ? latest : watching;
