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
 * What a button in Autopilot's email did (`done`; `button`: approve, publish or stop; `update`; `held`: how many
 * it couldn't act on), as a line above the updates; null when not back from one.
 */
export function afterButton(updates: Update[], done: string | null, button: string | null, updateId: string | null, held: number): string | null {
  const update = updateId ? updates.find((u) => u.id === updateId) : undefined;
  const named = update ? `${updateKind(update)}: ${update.post?.title ?? update.article?.title ?? update.title ?? update.line ?? ""}` : "";
  const by = (u: Update) => `${u.decidedBy ? ` by ${u.decidedBy}` : ""}${u.decidedAt ? `, ${timeAgo(new Date(u.decidedAt))}` : ""}`;
  const verb = button === "stop" ? "be stopped" : "go out";
  const couldnt = held > 0 ? ` ${held === 1 ? `One couldn't ${verb}: it's ticked below` : `${held} couldn't ${verb}: they're ticked below`}, to check.` : "";
  switch (done) {
    case "approved":
      return `Approved: ${named}. Undo is under Done.`;
    case "published":
      return `Published: what was going out by itself went now.${couldnt}`;
    case "stopped":
      return `Stopped: those updates wait for you now.${couldnt}`;
    case "refused":
      return `${button === "stop" ? "Nothing was stopped" : "Nothing went out"}: ${held === 1 ? `it couldn't ${verb} as it is. It's ticked below` : `they couldn't ${verb} as they are. They're ticked below`}, to check.`;
    case "replaced":
      return "That update was replaced when Autopilot read the pull request again: here's what it found now.";
    case "already": {
      if (!update) {
        return "Nothing it named is going out any more. Nothing more to do.";
      }
      const what =
        update.status === "applied"
          ? update.auto
            ? "went out by itself"
            : "was approved"
          : update.status === "dismissed"
            ? "was dismissed"
            : update.status === "undone"
              ? "was undone"
              : update.status === "pending" && update.waitReason?.startsWith("Stopped by")
                ? "was stopped"
                : null;
      if (what) {
        return `Done already: ${named} ${what}${update.auto ? "" : by(update)}. Nothing more to do.`;
      }
      // Publish now or Stop on one that waits for the team already (its article changed, say): why.
      if (button !== "approve") {
        return `${named} waits for you now${update.waitReason ? ` (${update.waitReason})` : ""}. Check it below.`;
      }
      return `${named} couldn't be approved as it is. Check it below.`;
    }
    default:
      return null;
  }
}
