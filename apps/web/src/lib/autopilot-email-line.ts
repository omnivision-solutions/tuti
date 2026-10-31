type Update = { id: string; status: string; waitReason?: string | null };

/** Whether someone stopped it (Stop, from the page or an email): it waits for the team, not to be approved unasked. */
export function stoppedUpdate(update: Update): boolean {
  return update.status === "pending" && !!update.waitReason?.startsWith("Stopped by");
}

/**
 * The review page's line for someone who came from an email's link: what became of the updates the
 * link named (`named`: their ids, or the likely ones), now. Counts what still waits, ticked or not.
 */
export function emailLine(fromEmail: "likely" | "named", named: string[], updates: Update[]): string {
  const now = updates.filter((update) => named.includes(update.id));
  const waiting = now.filter((update) => update.status === "pending" && !stoppedUpdate(update)).length;
  if (waiting > 0) {
    return waiting === 1 ? "the update it named waits for you: check it and approve." : `${waiting} updates it named wait for you: check them and approve.`;
  }
  // Stopped by a teammate (their Stop, before this link was opened): theirs to approve after all, not ticked.
  const stopped = now.filter(stoppedUpdate).length;
  if (stopped > 0) {
    return stopped === 1 ? "the update it named was stopped: it waits for the team, not ticked." : `${stopped} updates it named were stopped: they wait for the team, not ticked.`;
  }
  if (named.length === 0 && fromEmail === "likely" && updates.some((update) => update.status === "pending")) {
    return "Autopilot isn't sure of any of these: tick the ones to approve.";
  }
  if (now.some((update) => update.status === "stale")) {
    return "the update it named changed since: write it again, or dismiss it.";
  }
  if (now.length > 0 && now.every((update) => update.status === "scheduled")) {
    return "the updates it named go out by themselves (Publish now, or Stop).";
  }
  return "the updates it named were decided already.";
}
