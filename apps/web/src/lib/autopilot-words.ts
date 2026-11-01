import { timeAgo } from "@/lib/format";
import type { CodeChangeDetail } from "@/server/operations/code-changes";

/** What an update is, as the review page names it. */
export function updateKind(update: { kind: string; problem?: string }): string {
  switch (update.kind) {
    case "resolves":
      return "Closes the request";
    case "moves_forward":
      return "Progress update";
    case "links":
      return "Link";
    case "article_edit":
      return update.problem === "missing" ? "Missing info" : "Out of date";
    case "new_article":
      return "New article";
    default:
      return "Changelog line";
  }
}

type Update = CodeChangeDetail["actions"][number];

/**
 * What a button in Autopilot's email did (`done`; `button`: approve, publish or stop; `update`), as a line above the
 * updates; null when not back from one. `counts`: how many it couldn't act on (`held`), can't tell went (`unsure`),
 * and of the others it named, how many went out already (`went`, for Stop) or a teammate stopped (`kept`, for Publish now).
 */
export function afterButton(
  updates: Update[],
  done: string | null,
  button: string | null,
  updateId: string | null,
  { held = 0, unsure = 0, went = 0, kept = 0 }: { held?: number; unsure?: number; went?: number; kept?: number } = {},
): string | null {
  const update = updateId ? updates.find((u) => u.id === updateId) : undefined;
  const named = update ? `${updateKind(update)}: ${update.post?.title ?? update.article?.title ?? update.title ?? update.line ?? ""}` : "";
  const by = (u: Update) => `${u.decidedBy ? ` by ${u.decidedBy}` : ""}${u.decidedAt ? `, ${timeAgo(new Date(u.decidedAt))}` : ""}`;
  const verb = button === "stop" ? "be stopped" : "go out";
  const couldnt = held > 0 ? ` ${held === 1 ? `One couldn't ${verb}: it's ticked below` : `${held} couldn't ${verb}: they're ticked below`}, to check.` : "";
  const doubt =
    unsure > 0 ? ` ${unsure === 1 ? "Couldn't tell whether one went out: check it" : `Couldn't tell whether ${unsure} went out: check them`} below before doing it again.` : "";
  const othersOf = (w: number, k: number) =>
    (w > 0 ? ` ${w === 1 ? "One went out already: it's under Done, to undo there." : `${w} went out already: they're under Done, to undo there.`}` : "") +
    (k > 0 ? ` ${k === 1 ? "One was stopped: it waits for you below." : `${k} were stopped: they wait for you below.`}` : "");
  const others = othersOf(went, kept);
  switch (done) {
    case "approved":
      return `Approved: ${named}. Undo is under Done.`;
    case "unknown":
      return `Couldn't tell whether ${named} went out: check it below before doing it again.`;
    case "failed":
      return `Couldn't approve ${named} just now. Try again in a moment.`;
    case "published":
      return `Published: what was going out by itself went now.${others}${couldnt}${doubt}`;
    case "unsure":
      return `${doubt.trim()}${couldnt}${others}`;
    case "stopped":
      return `Stopped: those updates wait for you now.${others}${couldnt}`;
    case "refused":
      return `${button === "stop" ? "Nothing was stopped" : "Nothing went out"}: ${held === 1 ? `it couldn't ${verb} as it is. It's ticked below` : `they couldn't ${verb} as they are. They're ticked below`}, to check.${others}`;
    case "replaced":
      return button === "approve" || !button
        ? "That update was replaced when Autopilot read the pull request again: here's what it found now."
        : updates.some((u) => u.status === "scheduled")
          ? "Those updates were replaced when Autopilot read the pull request again: what goes out by itself now is below, marked In your email, with Publish now and Stop."
          : "Those updates were replaced when Autopilot read the pull request again: nothing goes out by itself now, and what it found waits for you below.";
    case "already": {
      if (!update) {
        return `Nothing it named is going out any more. Nothing more to do.${others}`;
      }
      // The others' counts, without the one it names (counted among them when it went out, or was stopped).
      const self =
        (button === "stop" && update.status === "applied") || (button === "publish" && update.status === "pending" && !!update.waitReason?.startsWith("Stopped by"));
      const rest = othersOf(button === "stop" && self ? went - 1 : went, button === "publish" && self ? kept - 1 : kept);
      const what =
        update.status === "applied"
          ? update.auto
            ? "went out by itself"
            : "was approved"
          : update.status === "dismissed"
            ? "was dismissed"
            : update.status === "undone"
              ? "was undone"
              : update.status === "pending" && button === "stop" && update.waitReason?.startsWith("Stopped by")
                ? "was stopped"
                : null;
      // Stop on one that went out: it's live, and Undo is what's left.
      if (button === "stop" && update.status === "applied") {
        return `${named} went out already${update.auto ? " by itself" : by(update)}: it's under Done, to undo there.${rest}`;
      }
      if (what) {
        return `Done already: ${named} ${what}${update.auto ? "" : by(update)}. Nothing more to do.${rest}`;
      }
      // Publish now or Stop on one that waits for the team already (its article changed, say): why.
      if (button !== "approve") {
        return `${named} waits for you now${update.waitReason ? ` (${update.waitReason})` : ""}. Check it below.${rest}`;
      }
      return `${named} couldn't be approved as it is. Check it below.`;
    }
    default:
      return null;
  }
}

/** Why a change is in To review, on its row (none for one reviewed): updates waiting first, whatever its state. */
export function stateBadge(change: { state: string; waiting: number }): { label: string; variant: "highlight" | "secondary" | "destructive" } | null {
  if (change.waiting > 0) {
    return { label: `${change.waiting} to review`, variant: "highlight" };
  }
  return change.state === "analysing"
    ? { label: "Analysing", variant: "secondary" }
    : change.state === "failed"
      ? { label: "Failed", variant: "destructive" }
      : change.state === "paused"
        ? { label: "Paused", variant: "secondary" }
        : null;
}
