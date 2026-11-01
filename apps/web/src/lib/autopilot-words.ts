import { timeAgo } from "@/lib/format";
import type { CodeChangeDetail } from "@/server/operations/code-changes";

export const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

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

/**
 * What a change's row in Autopilot's list says under its title, past its updates' chips: its state when it
 * isn't read yet or can't be (analysing, failed, paused), the reason for a paused one or one with nothing to
 * do, and its button.
 */
export function changeRow(change: { state: string; waiting: number; reason: string | null }): {
  badge: { label: string; variant: "secondary" | "destructive" } | null;
  reason: string | null;
  action: "Resume" | "Analyse anyway" | null;
} {
  const badge =
    change.state === "analysing"
      ? { label: "Analysing", variant: "secondary" as const }
      : change.state === "failed"
        ? { label: "Failed", variant: "destructive" as const }
        : change.state === "paused"
          ? { label: "Paused", variant: "secondary" as const }
          : null;
  // Nothing to do, though an update the team stopped still waits: it's to review, not Analyse anyway.
  const nothingToDo = change.state === "nothing_to_do" && change.waiting === 0;
  return {
    badge,
    reason: nothingToDo || change.state === "paused" ? change.reason : null,
    action: change.state === "paused" ? "Resume" : nothingToDo ? "Analyse anyway" : null,
  };
}

/** The order a change's page lists its updates in: feedback first, then the docs (edits, then new articles), then the changelog line. */
export const UPDATE_ORDER = ["resolves", "moves_forward", "links", "article_edit", "new_article", "changelog_line"];

const CHIPS: Record<string, { one: string; many: string; tone: string }> = {
  resolves: { one: "request closed", many: "requests closed", tone: "closes" },
  moves_forward: { one: "request updated", many: "requests updated", tone: "progress" },
  links: { one: "post linked", many: "posts linked", tone: "neutral" },
  article_edit: { one: "article update", many: "article updates", tone: "edit" },
  new_article: { one: "new article", many: "new articles", tone: "new" },
};

/**
 * A change's updates waiting, a chip per kind in its page's order ("1 request closed", "2 article
 * updates"), each opening its first (`id`); `tone`: its colour, so a list of changes can be skimmed.
 */
export function updateChips(updates: { id: string; kind: string }[]): { kind: string; label: string; id: string; tone: string }[] {
  return UPDATE_ORDER.flatMap((kind) => {
    const mine = updates.filter((update) => update.kind === kind);
    if (mine.length === 0) {
      return [];
    }
    const chip = CHIPS[kind];
    return [{ kind, id: mine[0]!.id, label: chip ? `${mine.length} ${mine.length === 1 ? chip.one : chip.many}` : "Changelog line", tone: chip?.tone ?? "neutral" }];
  });
}

/** What approving the chosen updates does, a line per kind (`emails`: how many people it emails, in all). */
export function whenApproved(chosen: { kind: string }[], emails: number): string[] {
  const count = (kind: string) => chosen.filter((update) => update.kind === kind).length;
  const lines: string[] = [];
  const closes = count("resolves");
  if (closes) {
    lines.push(`${plural(closes, "request")} completed${emails ? `, up to ${plural(emails, "person", "people")} emailed` : ""}`);
  }
  if (count("moves_forward")) {
    lines.push(`${plural(count("moves_forward"), "progress update")} posted`);
  }
  if (count("links")) {
    lines.push(`${plural(count("links"), "post")} linked to the pull request`);
  }
  if (count("article_edit")) {
    lines.push(`${plural(count("article_edit"), "article edit")} published`);
  }
  if (count("new_article")) {
    lines.push(`${plural(count("new_article"), "new article")} drafted (only your team sees ${count("new_article") === 1 ? "it" : "them"})`);
  }
  if (count("changelog_line")) {
    lines.push("The changelog line updated (still a draft)");
  }
  return lines;
}
