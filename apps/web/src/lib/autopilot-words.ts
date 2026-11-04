import { timeAgo } from "@/lib/format";
import type { CodeChangeDetail } from "@/server/operations/code-changes";

export const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** What an update is, as the review page names it. */
export function updateKind(update: { kind: string; problem?: string }): string {
  switch (update.kind) {
    case "resolves":
      return "Completes the post";
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

export const STATUS_LABELS: Record<string, string> = { open: "Open", under_review: "Under review", planned: "Planned", in_progress: "In progress", completed: "Completed", closed: "Closed" };
/** Statuses a progress update moves on to In progress (as codeChangeActions.apply does). */
const NOT_STARTED = new Set(["open", "under_review", "planned"]);

/** The longest comment a post takes: POST_COMMENT_MAX in @tuti/jobs (which a page in the browser can't import). */
export const POST_COMMENT_LIMIT = 5000;

/**
 * What a post's card says while its update waits, and why Approve is off (`blocked`): who stopped it (`stopped`, its
 * part, said with when it would have gone out), its comment too long to post (as the server's `tooLong` says it, counted
 * as the team edits), or else why it waits (`waitReason`).
 */
export function postWaits({ parts, text, commented, waitReason }: { parts: { status: string; waitReason?: string | null; wouldHaveGoneOutAt?: string | null }[]; text: string; commented: boolean; waitReason?: string | null }) {
  const stopped = parts.find((part) => part.status === "pending" && part.waitReason?.startsWith("Stopped by"));
  const tooLong =
    commented && text.length > POST_COMMENT_LIMIT
      ? `Its comment is too long to post (${text.length.toLocaleString("en")} of ${POST_COMMENT_LIMIT.toLocaleString("en")} characters): shorten it`
      : null;
  // The update's reason, else a waiting part's: not "Another part of its update waits for you", which points at parts a
  // whole-update card doesn't list.
  const other = [waitReason, ...parts.filter((part) => part.status === "pending").map((part) => part.waitReason)].find(
    (why) => why && !/^(Stopped by|Its comment is too long|Another part of its update)/.test(why),
  );
  return {
    stopped,
    lines: tooLong ? [`${tooLong}.`] : other ? [`Waits for you: ${other}.`] : [],
    blocked: (commented && !text.trim()) || tooLong !== null,
  };
}

/** Whether an update is one Autopilot's review shows: not the changelog line (reviewed in its draft), nor a link still waiting (it changes nothing customers see). */
export const reviewItem = (update: { kind: string; status: string }) =>
  update.kind !== "changelog_line" && !(update.kind === "links" && ["pending", "stale", "scheduled"].includes(update.status));

/** What the update does to the post's status: "Open → Completed", "Open → In progress", "Stays In progress". */
export function statusChange(kind: string, status: string): string {
  const now = STATUS_LABELS[status] ?? status;
  if (kind === "resolves") {
    return status === "completed" ? "Already completed" : `${now} → Completed`;
  }
  return NOT_STARTED.has(status) ? `${now} → In progress` : `Stays ${now}`;
}

/**
 * A post's review with its update as one (docs/plan.md, V4; `update`: codeChanges.target's): its parts waiting become
 * one card, a waiting part's id, with its version (`version`: what Approve applies) and, from more than one pull
 * request, one status change with one comment (theirs joined), its parts (`parts`) under it.
 */
export function withPostUpdate<U extends Update>(
  updates: U[],
  update:
    | { parts: string[]; revision: string; kind: string; comment: string; status: string; applyLikely: boolean; emails: number; waitReason?: string | null }
    | null
    | undefined,
): (U & { parts?: U[]; version?: string })[] {
  // A part waiting that isn't in the update as read (it landed since): no card of its own, so it can't be approved
  // without its update's version. Reloaded, it's in the update.
  const landed = (one: U) =>
    (one.kind === "resolves" || one.kind === "moves_forward") && (one.status === "pending" || one.status === "scheduled") && !update?.parts.includes(one.id);
  updates = updates.filter((one) => !landed(one));
  const parts = update ? update.parts.flatMap((id) => updates.filter((one) => one.id === id)) : [];
  if (!update || parts.length === 0) {
    return updates;
  }
  // A part of it decided or gone between the two reads: its comment and version are of an update that isn't there any
  // more, so no card (nothing here approves it); reloaded, the update as it is now.
  if (parts.length !== update.parts.length || parts.some((part) => part.status !== "pending" && part.status !== "scheduled")) {
    return updates.filter((one) => !update.parts.includes(one.id) || (one.status !== "pending" && one.status !== "scheduled"));
  }
  // Its id: a part waiting (one going out by itself isn't approved as such), else the first. Not its own comment: the update's.
  const { comment: _own, ...first } = parts.find((part) => part.status === "pending") ?? parts[0]!;
  const merged =
    parts.length === 1
      ? { ...parts[0]!, version: update.revision }
      : ({
          ...first,
          kind: update.kind,
          status: update.status,
          reason: "",
          applyLikely: update.applyLikely,
          emails: update.emails,
          // A comment to post (a completion with none folded in posts none).
          ...((update.kind === "moves_forward" || update.comment.trim()) && { comment: update.comment }),
          waitReason: update.waitReason ?? parts.find((part) => part.status === "pending" && part.waitReason)?.waitReason ?? null,
          parts,
          version: update.revision,
          // (Its part's own comment left out: an update of the same shape.)
        } as unknown as U & { parts: U[]; version: string });
  return [merged, ...updates.filter((one) => !update.parts.includes(one.id))];
}

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
  const couldnt = held > 0 ? ` ${held === 1 ? `One couldn't ${verb}: it waits for you below` : `${held} couldn't ${verb}: they wait for you below`}, to check.` : "";
  const doubt =
    unsure > 0 ? ` ${unsure === 1 ? "Couldn't tell whether one went out: check it" : `Couldn't tell whether ${unsure} went out: check them`} below before doing it again.` : "";
  const othersOf = (w: number, k: number) =>
    (w > 0 ? ` ${w === 1 ? "One went out already: undo it on its page below." : `${w} went out already: undo them on their pages below.`}` : "") +
    (k > 0 ? ` ${k === 1 ? "One was stopped: it waits for you below." : `${k} were stopped: they wait for you below.`}` : "");
  const others = othersOf(went, kept);
  switch (done) {
    case "approved":
      // A review has each pull request's Undo in its chip's popover.
      // (A changelog line isn't in a review's chips: no Undo to point to.)
      return `Approved: ${named}.${update?.kind === "changelog_line" ? "" : " Undo it from its pull request's chip."}`;
    case "changed":
      return `Nothing was approved: ${update?.post ? `the update to ${update.post.title}` : (update?.article?.title ?? "the article")} changed since the email. Review it as it is now below.`;
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
      return `${button === "stop" ? "Nothing was stopped" : "Nothing went out"}: ${held === 1 ? `it couldn't ${verb} as it is. It waits for you below` : `they couldn't ${verb} as they are. They wait for you below`}, to check.${others}`;
    case "replaced":
      return button === "approve" || !button
        ? "That update was replaced when Autopilot read the pull request again: here's what it found now."
        : updates.some((u) => u.status === "scheduled")
          ? "Those updates were replaced when Autopilot read the pull request again: what goes out by itself now is below, with Publish now and Stop on its page."
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
        return `${named} went out already${update.auto ? " by itself" : by(update)}: undo it on its page below.${rest}`;
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

/**
 * What a post's or article's updates do to it (the kinds of those waiting or applied), the most first: its badge
 * (completing, in_progress, new, updated). None when there are none (all dismissed or undone).
 */
export function targetBadge(kinds: string[]): "completing" | "in_progress" | "new" | "updated" | null {
  if (kinds.length === 0) {
    return null;
  }
  return kinds.includes("resolves") ? "completing" : kinds.includes("moves_forward") ? "in_progress" : kinds.includes("new_article") ? "new" : "updated";
}

/** The order a change's page lists its updates in: feedback first, then the docs (edits, then new articles), then the changelog line. */
export const UPDATE_ORDER = ["resolves", "moves_forward", "links", "article_edit", "new_article", "changelog_line"];

const CHIPS: Record<string, { one: string; many: string; tone: string }> = {
  resolves: { one: "post to complete", many: "posts to complete", tone: "closes" },
  moves_forward: { one: "post to update", many: "posts to update", tone: "progress" },
  links: { one: "post to link", many: "posts to link", tone: "neutral" },
  article_edit: { one: "article to update", many: "articles to update", tone: "edit" },
  new_article: { one: "new article", many: "new articles", tone: "new" },
};

/**
 * A change's updates waiting, a chip per kind in its page's order ("1 post to complete", "2 articles
 * to update": none has gone out yet), each opening its first (`id`); `tone`: its colour, so a list of changes can be skimmed.
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

/**
 * What Undo on an approved update puts back, as its dialog says first. A post's update applied as one (`together`) is
 * undone whole, whichever of its parts' Undo is clicked: said from its completion when it had one (the post leaves
 * Completed, and who was emailed that it shipped), from `updates` (the page's).
 */
export function undoWarning(update: Update, updates: Update[]): string {
  const together = update.together && update.together.length > 1 ? update.together : null;
  const whole = (together && updates.find((one) => together.includes(one.id) && one.kind === "resolves")) || update;
  return (
    (together ? `It went out as one update with ${plural(together.length - 1, "other pull request's part", "other pull requests' parts")}: all of it is undone. ` : "") +
    undoesOne(whole)
  );
}

function undoesOne(update: Update): string {
  switch (update.kind) {
    case "resolves":
      // Completed already when it was approved: it stays so, and what's due still goes.
      if (!update.putsBackStatus) {
        return `${update.post?.title} stays Completed (it was already), so its shipped emails still go.${update.comment ? " Its comment is deleted." : ""}`;
      }
      return `${update.post?.title} goes back to the status it had${update.comment ? ", and its comment is deleted" : ""}.${
        update.emailed ? ` ${plural(update.emailed, "person was", "people were")} already emailed that it shipped; that can't be taken back.` : " Its shipped emails not sent yet won't be."
      }`;
    case "moves_forward":
      return "Its progress update is deleted, and the post goes back to the status it had.";
    case "links":
      return "The post's link to the pull request is removed.";
    case "article_edit":
      return "The article's previous version is published again.";
    case "new_article":
      return "The draft is deleted.";
    default:
      return "The changelog line goes back to what it said.";
  }
}

/** What approving the chosen updates does, a line per kind (`emails`: how many people it emails, in all). */
export function whenApproved(chosen: { kind: string; comment?: string }[], emails: number): string[] {
  const count = (kind: string) => chosen.filter((update) => update.kind === kind).length;
  const lines: string[] = [];
  const closes = count("resolves");
  if (closes) {
    lines.push(`${plural(closes, "post")} completed${emails ? `, up to ${plural(emails, "person", "people")} emailed` : ""}`);
  }
  // Completing with progress updates folded in: their comment goes with it.
  const folded = chosen.filter((update) => update.kind === "resolves" && update.comment !== undefined).length;
  if (folded) {
    lines.push(`${plural(folded, "comment")} posted with ${folded === 1 ? "it" : "them"}`);
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

/** Publish now's confirm when it completes posts: how many, and how many people that emails. */
export function completingWarning(posts: number, emails: number): string {
  const people = `${emails} ${emails === 1 ? "person" : "people"}`;
  return posts === 1
    ? `Completing the post emails up to ${people} who asked for it that it shipped. That can't be taken back.`
    : `Completing ${posts} posts emails up to ${people} who asked for them that they shipped. That can't be taken back.`;
}

/**
 * What an article's Dismiss takes out: every edit still to go out (waiting, scheduled or out of date, not one decided),
 * the newest first, so none is under another when it's taken out.
 */
export function dismissOrder<T extends { status: string; createdAt: string }>(updates: T[]): T[] {
  return updates.filter((update) => ["pending", "scheduled", "stale"].includes(update.status)).toSorted((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/** What an article's Approve publishes: those of them in its changes (saved as a revision; one the previous release wrote, out of date, isn't). */
export function goesLive<T extends { status: string; createdAt: string; revision?: string }>(updates: T[]): T[] {
  return dismissOrder(updates).filter((update) => update.revision);
}

/**
 * Why an article's review shows nothing while its edits wait (or, `of`, not these): `stale` of them out of date (written on an earlier
 * version), `rewritable` of those a pull request's, offered to write again where analysis can run (else `off`, why
 * not) or said to be being written (`writing`), or that writing them again failed (`failed`: why, from their pull
 * requests' analysis); `still`: being written for a while; the rest (Verify's fixes) only dismissed. None out of date, its changes were saved back to the
 * published text.
 */
export function nothingToShow(
  stale: number,
  {
    rewritable,
    off,
    writing,
    still = false,
    failed = [],
    of,
  }: { rewritable: number; off: string | null; writing: boolean; still?: boolean; failed?: string[]; of?: number },
): string {
  if (stale === 0) {
    return "Nothing to show: its unpublished changes are the same as the published article.";
  }
  // `of`: its edits waiting, when its changes show something (its other edits, or the team's): these aren't in them.
  const whose = stale === of ? (stale === 1 ? "Its edit was" : `Its ${stale} edits were`) : stale === 1 ? "One of its edits was" : `${stale} of its edits were`;
  const lead =
    of !== undefined
      ? `${whose} written on an earlier version of the article, so ${stale === 1 ? "it isn't" : "they aren't"} in the changes below.`
    : `Nothing to show yet: ${stale === 1 ? "its edit was" : `${stale} of its edits were`} written on an earlier version of the article.`;
  const fixes = stale - rewritable;
  // The pull requests' ones: all of them ("it", "them"), or some ("the one from a pull request", "the 2 from pull requests").
  const some = rewritable === stale ? (stale === 1 ? "it" : "them") : rewritable === 1 ? "the one from a pull request" : `the ${rewritable} from pull requests`;
  const rest = fixes === 0 ? "" : ` ${fixes === 1 ? "Verify's fix" : `Verify's ${fixes} fixes`} can only be dismissed.`;
  const it = stale === 1 ? "it" : "them";
  if (rewritable === 0) {
    return `${lead} Dismiss ${it}.`;
  }
  if (writing) {
    return `${lead} ${still ? "Still writing" : "Writing"} ${some} again… ${rewritable === 1 ? "It shows here once it's" : "They show here once they're"} written.${rest}`;
  }
  if (off) {
    return `${lead} ${rewritable === stale ? (stale === 1 ? "It" : "They") : `${some[0]!.toUpperCase()}${some.slice(1)}`} can't be written again while ${off}: dismiss ${it}.`;
  }
  if (failed.length > 0) {
    return `${lead} ${rewritable === 1 ? "It" : "They"} couldn't be written again. ${failed.join(" ")} Write ${some} again to try once more, or dismiss ${it}.${rest}`;
  }
  return `${lead} Write ${some} again to see what ${rewritable === 1 ? "it changes" : "they change"}, or dismiss ${it}.${rest}`;
}

/** While an edit is written again, its review looks again every 3 seconds for 2 minutes (40 looks), then every 15 seconds. */
export const LOOKS_BEFORE_STILL = 40;
export const lookAgainIn = (looks: number) => (looks < LOOKS_BEFORE_STILL ? 3_000 : 15_000);

/** A post's part (its pull request's progress update or completion), not an article's. */
export const POST_PART = new Set(["resolves", "moves_forward"]);

/** What each part says of itself: waiting, going out, or what became of it. */
export function partState(update: {
  status: string;
  kind: string;
  auto: boolean;
  number: number | null;
  waitReason?: string | null;
  decidedBy?: string | null;
  dismissReason?: string | null;
}): string {
  if (update.status === "pending") {
    // A Verify fix always waits: no reason to give.
    return update.waitReason && update.number !== null ? `Waits for you: ${update.waitReason}` : "Waits for you";
  }
  if (update.status === "stale") {
    return "Out of date: the article changed since it was written";
  }
  if (update.status === "scheduled") {
    return "Goes out by itself";
  }
  const by = update.decidedBy && !update.auto ? ` by ${update.decidedBy}` : "";
  return update.status === "applied"
    ? update.auto
      ? update.kind === "links"
        ? "Linked by Autopilot"
        : POST_PART.has(update.kind)
          ? "Applied by Autopilot"
          : "Published by Autopilot"
      : `Approved${by}`
    : update.status === "undone"
      ? `Undone${by}`
      : `Dismissed${by}${update.dismissReason ? `: ${update.dismissReason}` : ""}`;
}

/** Settings → Autopilot's How it's doing: how many of its last updates (`of`, up to 50 it can count) went out as written. */
export function autopilotRecordText({ kept, of, wentOut }: { kept: number; of: number; wentOut: boolean }): string {
  if (of === 0) {
    return wentOut
      ? "Nothing it can count yet: drafts finished in the editor, and updates approved before this was kept, aren't counted."
      : "Nothing has gone out yet. Once updates are approved, this says how many were kept as Autopilot wrote them.";
  }
  if (of === 1) {
    return kept === 1
      ? "Kept the one update it can count unchanged: not edited before approving, nor undone since."
      : "The one update it can count was edited before approving, or undone since.";
  }
  return `Kept ${kept} of its last ${of} updates unchanged: not edited before approving, nor undone since.`;
}
