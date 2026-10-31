/**
 * The review page's line for someone who came from an email's link: what became of the updates the
 * link named (`named`: their ids, or the likely ones), now. Counts what still waits, ticked or not.
 */
export function emailLine(fromEmail: "likely" | "named", named: string[], updates: { id: string; status: string }[]): string {
  const now = updates.filter((update) => named.includes(update.id));
  const waiting = now.filter((update) => update.status === "pending").length;
  if (waiting > 0) {
    return waiting === 1 ? "the update it named waits for you: check it and approve." : `${waiting} updates it named wait for you: check them and approve.`;
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
