import { describe, expect, it, test } from "vitest";

import { afterButton, autopilotRecordText, undoQuestion, changeRow, draftPick, partState, plainWhy, completingWarning, dismissOrder, goesLive, lookAgainIn, nothingToShow, outcomeOf, postWaits, publishFirst, commentToApprove, reviewItem, statusChange, undoWarning, updateChips, withPostUpdate } from "./autopilot-words";

const progress = (status: string, waitReason: string | null = null) =>
  ({ id: "u1", kind: "moves_forward", status, waitReason, auto: false, decidedBy: null, decidedAt: null, post: { title: "Dark mode" } }) as unknown as Parameters<typeof afterButton>[0][number];

test("Publish now with every update refused doesn't say anything was published", () => {
  expect(afterButton([], "refused", "publish", null, { held: 1 })).toBe("Nothing went out: it couldn't go out as it is. It waits for you below, to check.");
  expect(afterButton([], "refused", "publish", null, { held: 2 })).toBe("Nothing went out: they couldn't go out as they are. They wait for you below, to check.");
  expect(afterButton([], "published", "publish", null, { held: 1 })).toBe("Published: what was going out by itself went now. One couldn't go out: it waits for you below, to check.");
});

test("Stop or Publish now on an update already waiting for the team says why it waits, not that it couldn't be approved", () => {
  const waiting = progress("pending", "Its article changed");
  expect(afterButton([waiting], "already", "stop", "u1")).toBe("Progress update: Dark mode waits for you now (Its article changed). Check it below.");
  expect(afterButton([waiting], "already", "approve", "u1")).toBe("Progress update: Dark mode couldn't be approved as it is. Check it below.");
});

test("Approve that can't tell whether it went, or failed for now, says so rather than done already", () => {
  const update = progress("applied");
  expect(afterButton([update], "unknown", "approve", "u1")).toBe("Couldn't tell whether Progress update: Dark mode went out: check it below before doing it again.");
  expect(afterButton([progress("pending")], "failed", "approve", "u1")).toBe("Couldn't approve Progress update: Dark mode just now. Try again in a moment.");
  expect(afterButton([], "unsure", "publish", null, { unsure: 1 })).toBe("Couldn't tell whether one went out: check it below before doing it again.");
});

test("Publish now or Stop whose updates were replaced (analysed again) says so, not that nothing's going out", () => {
  expect(afterButton([progress("scheduled")], "replaced", "stop", null)).toBe(
    "Those updates were replaced when Autopilot read the pull request again: what goes out by itself now is below, with Publish now and Stop on its page.",
  );
  // Nothing goes out by itself now: it doesn't say there is.
  expect(afterButton([progress("pending")], "replaced", "stop", null)).toBe(
    "Those updates were replaced when Autopilot read the pull request again: nothing goes out by itself now, and what it found waits for you below.",
  );
});

test("Approve refused on an update someone stopped says it couldn't be approved, not that it's done", () => {
  expect(afterButton([progress("pending", "Stopped by Bob")], "already", "approve", "u1")).toBe("Progress update: Dark mode couldn't be approved as it is. Check it below.");
  expect(afterButton([progress("pending", "Stopped by Bob")], "already", "stop", "u1")).toBe("Done already: Progress update: Dark mode was stopped. Nothing more to do.");
  // Publish now on it: it didn't go, and it waits.
  expect(afterButton([progress("pending", "Stopped by Bob")], "already", "publish", "u1")).toBe("Progress update: Dark mode waits for you now (Stopped by Bob). Check it below.");
});

test("done already names the update, and says the others someone decided first, not counting it twice", () => {
  // Publish now: the one named went out (by a teammate), another was stopped.
  expect(afterButton([progress("applied")], "already", "publish", "u1", { kept: 1 })).toBe(
    "Done already: Progress update: Dark mode was approved. Nothing more to do. One was stopped: it waits for you below.",
  );
  // Stop: the one named went out; Undo is what's left (and it isn't counted again).
  expect(afterButton([progress("applied")], "already", "stop", "u1", { went: 1 })).toBe("Progress update: Dark mode went out already: undo it on its page below.");
});

test("Stop or Publish now says which of the others it named someone decided first: went out already, or stopped", () => {
  expect(afterButton([], "stopped", "stop", null, { went: 1 })).toBe("Stopped: those updates wait for you now. One went out already: undo it on its page below.");
  expect(afterButton([], "published", "publish", null, { kept: 2 })).toBe("Published: what was going out by itself went now. 2 were stopped: they wait for you below.");
});

test("nothing acted on (refused, or can't tell) still says which others went out already or were stopped", () => {
  expect(afterButton([], "refused", "stop", null, { held: 1, went: 1 })).toBe(
    "Nothing was stopped: it couldn't be stopped as it is. It waits for you below, to check. One went out already: undo it on its page below.",
  );
  expect(afterButton([], "unsure", "publish", null, { unsure: 1, kept: 1 })).toBe(
    "Couldn't tell whether one went out: check it below before doing it again. One was stopped: it waits for you below.",
  );
});

describe("changeRow", () => {
  const row = (state: string, waiting: number) => changeRow({ state, waiting, reason: "Only the team sees this." });

  it("says a change's state when it isn't read yet or can't be (analysing, failed, paused); its updates' chips say the rest", () => {
    expect(row("analysing", 2).badge).toEqual({ label: "Analysing", variant: "secondary" });
    expect(row("failed", 2).badge).toEqual({ label: "Failed", variant: "destructive" });
    expect(row("paused", 0).badge).toEqual({ label: "Paused", variant: "secondary" });
    expect(row("ready", 2).badge).toBeNull();
    expect(row("ready", 0).badge).toBeNull();
  });

  it("nothing to do: its reason and Analyse anyway; with an update the team stopped still waiting, neither, and it says so", () => {
    expect(row("nothing_to_do", 0)).toEqual({ badge: null, reason: "Only the team sees this.", action: "Analyse anyway" });
    expect(row("nothing_to_do", 1)).toEqual({ badge: null, reason: null, action: null });
  });

  it("paused: its reason and Resume; others neither", () => {
    expect(row("paused", 0)).toMatchObject({ reason: "Only the team sees this.", action: "Resume" });
    expect(row("failed", 0)).toMatchObject({ reason: null, action: null });
  });
});

test("a change's updates in chips, a kind each in its page's order, counted, said as waiting (none has gone out), each opening the first of its kind", () => {
  const chips = updateChips([
    { id: "e1", kind: "article_edit" },
    { id: "c1", kind: "changelog_line" },
    { id: "r1", kind: "resolves" },
    { id: "e2", kind: "article_edit" },
    { id: "n1", kind: "new_article" },
    { id: "m1", kind: "moves_forward" },
    { id: "l1", kind: "links" },
  ]);
  expect(chips.map((chip) => [chip.label, chip.id, chip.tone])).toEqual([
    ["1 post to complete", "r1", "closes"],
    ["1 post to update", "m1", "progress"],
    ["1 post to link", "l1", "neutral"],
    ["2 articles to update", "e1", "edit"],
    ["1 new article", "n1", "new"],
    ["Changelog line", "c1", "neutral"],
  ]);
  expect(updateChips([])).toEqual([]);
});

test("Publish now's confirm says how many posts it completes and how many people that emails", () => {
  expect(completingWarning(1, 1)).toBe("Completing the post emails up to 1 person who asked for it that it shipped. That can't be taken back.");
  expect(completingWarning(2, 42)).toBe("Completing 2 posts emails up to 42 people who asked for them that they shipped. That can't be taken back.");
});

test("an article's Dismiss takes out every edit still to go out, scheduled ones too, the newest first", () => {
  const edits = [
    { id: "a", status: "scheduled", createdAt: "2026-11-02T10:00:00Z" },
    { id: "b", status: "pending", createdAt: "2026-11-02T11:00:00Z" },
    { id: "c", status: "applied", createdAt: "2026-11-02T12:00:00Z" },
    { id: "d", status: "stale", createdAt: "2026-11-02T09:00:00Z" },
  ];
  expect(dismissOrder(edits).map((edit) => edit.id)).toEqual(["b", "a", "d"]);
});

test("an article's Approve counts the edits in its changes, not an out-of-date one the previous release wrote", () => {
  const edits = [
    { id: "a", status: "pending", createdAt: "2026-11-02T10:00:00Z", revision: "r1" },
    { id: "b", status: "stale", createdAt: "2026-11-02T11:00:00Z", revision: "r2" },
    { id: "c", status: "stale", createdAt: "2026-11-02T09:00:00Z" },
  ];
  expect(goesLive(edits).map((edit) => edit.id)).toEqual(["b", "a"]);
});

test("a post's update is one card: a waiting part's id (one going out by itself can't be approved as such), and a completion with no comment folded in posts none", () => {
  type U = Parameters<typeof withPostUpdate>[0][number];
  const part = (id: string, kind: string, status: string, comment?: string) => ({ id, kind, status, waitReason: null, ...(comment !== undefined && { comment }) }) as unknown as U;
  const update = { parts: ["a", "b"], revision: "v1", kind: "moves_forward", comment: "Weekly.\n\nMonthly.", status: "pending", applyLikely: false, emails: 0 };
  // A still going out, B stopped (waiting): the card is B's, for the version of both.
  const [card] = withPostUpdate([part("a", "moves_forward", "scheduled", "Weekly."), part("b", "moves_forward", "pending", "Monthly.")], update);
  expect(card).toMatchObject({ id: "b", status: "pending", comment: "Weekly.\n\nMonthly.", version: "v1", parts: [{ id: "a" }, { id: "b" }] });
  // Completing, with a progress update that has no comment: nothing to write first.
  const [completes] = withPostUpdate([part("a", "resolves", "pending"), part("b", "moves_forward", "pending", "")], { ...update, kind: "resolves", comment: "" });
  expect(completes).toMatchObject({ id: "a", kind: "resolves" });
  expect(completes).not.toHaveProperty("comment");
  // The blank progress update merged first: the card is its part's, but not its blank comment.
  const [later] = withPostUpdate([part("a", "moves_forward", "pending", ""), part("b", "resolves", "pending")], { ...update, kind: "resolves", comment: "" });
  expect(later).toMatchObject({ id: "a", kind: "resolves" });
  expect(later).not.toHaveProperty("comment");
});

test("Undo on any part of a post's update that completed it warns about the completion: the post leaves Completed, and who was emailed", () => {
  type U = Parameters<typeof undoWarning>[0];
  const applied = (id: string, kind: string, extra = {}) =>
    ({ id, kind, status: "applied", together: ["p", "c"], post: { title: "Recurring events" }, ...extra }) as unknown as U;
  const progress = applied("p", "moves_forward", { comment: "Weekly repeats are out." });
  const completion = applied("c", "resolves", { comment: "Weekly repeats are out.", putsBackStatus: true, emailed: 3 });
  const warning =
    "It went out as one update with 1 other pull request's part: all of it is undone. Recurring events goes back to the status it had, and its comment is deleted. 3 people were already emailed that it shipped; that can't be taken back.";
  expect(undoWarning(progress, [progress, completion])).toBe(warning);
  expect(undoWarning(completion, [progress, completion])).toBe(warning);
  // A progress update alone says what it does.
  const alone = { ...progress, together: undefined } as U;
  expect(undoWarning(alone, [alone])).toBe("Its progress update is deleted, and the post goes back to the status it had.");
});

test("a post's part that landed after its update was read has no card of its own (it can't be approved without the update's version)", () => {
  type U = Parameters<typeof withPostUpdate>[0][number];
  const part = (id: string, status = "pending") => ({ id, kind: "moves_forward", status, waitReason: null, comment: id }) as unknown as U;
  const link = { id: "l", kind: "links", status: "pending", waitReason: null } as unknown as U;
  const update = { parts: ["a"], revision: "v1", kind: "moves_forward", comment: "a", status: "pending", applyLikely: true, emails: 0 };
  expect(withPostUpdate([part("a"), part("b"), link], update).map((card) => card.id)).toEqual(["a", "l"]);
  // None read at all (all of them landed since): none to approve here until it's reloaded.
  expect(withPostUpdate([part("b"), link], null).map((card) => card.id)).toEqual(["l"]);
  // Decided ones stay, under Done.
  expect(withPostUpdate([part("a"), part("c", "applied")], update).map((card) => card.id)).toEqual(["a", "c"]);
});

test("a post's update with a part decided or gone since it was read has no card (its comment and version are of an update that isn't there)", () => {
  type U = Parameters<typeof withPostUpdate>[0][number];
  const part = (id: string, status = "pending") => ({ id, kind: "moves_forward", status, waitReason: null, comment: id }) as unknown as U;
  const update = { parts: ["a", "b"], revision: "v1", kind: "moves_forward", comment: "a\n\nb", status: "pending", applyLikely: true, emails: 0 };
  // b dismissed between the reads: a waits, but no card offers the update as read; b is under Done.
  expect(withPostUpdate([part("a"), part("b", "dismissed")], update).map((card) => [card.id, card.version ?? null])).toEqual([["b", null]]);
  // b gone (analysed again): the same.
  expect(withPostUpdate([part("a")], update).map((card) => card.id)).toEqual([]);
});

test("Approved from the email: an article's edit and a post's update say their Undo is in the pull request's chip; a changelog line doesn't", () => {
  const edit = { id: "e1", kind: "article_edit", status: "applied", article: { title: "Change the theme" } } as unknown as Parameters<typeof afterButton>[0][number];
  expect(afterButton([edit], "approved", "approve", "e1")).toMatch(/: Change the theme\. Undo it from its pull request's chip\.$/);
  expect(afterButton([progress("applied")], "approved", "approve", "u1")).toMatch(/: Dark mode\. Undo it from its pull request's chip\.$/);
  // A changelog line has no chip with an Undo: none pointed to.
  const line = { id: "l1", kind: "changelog_line", status: "applied", line: "A dark theme" } as unknown as Parameters<typeof afterButton>[0][number];
  expect(afterButton([line], "approved", "approve", "l1")).toBe("Approved: Changelog line: A dark theme.");
});

test("an article's review with nothing to show says why, and offers Write again only where it can be", () => {
  const can = { rewritable: 1, off: null, writing: false };
  expect(nothingToShow(1, can)).toBe("Nothing to show yet: its edit was written on an earlier version of the article. Write it again to see what it changes, or dismiss it.");
  expect(nothingToShow(2, { ...can, rewritable: 2 })).toBe(
    "Nothing to show yet: 2 of its edits were written on an earlier version of the article. Write them again to see what they change, or dismiss them.",
  );
  // Analysis can't run (Autopilot off in Settings, AI not set up, a plan without it): why, and only Dismiss.
  expect(nothingToShow(1, { ...can, off: "Autopilot is off in Settings → Autopilot" })).toBe(
    "Nothing to show yet: its edit was written on an earlier version of the article. It can't be written again while Autopilot is off in Settings → Autopilot: dismiss it.",
  );
  // Verify's fixes: no pull request to analyse again, only dismissed; with a pull request's, only that one is written again.
  expect(nothingToShow(1, { ...can, rewritable: 0 })).toBe("Nothing to show yet: its edit was written on an earlier version of the article. Dismiss it.");
  expect(nothingToShow(3, { ...can, rewritable: 2 })).toBe(
    "Nothing to show yet: 3 of its edits were written on an earlier version of the article. Write the 2 from pull requests again to see what they change, or dismiss them. Verify's fix can only be dismissed.",
  );
  expect(nothingToShow(2, { ...can, off: "AI isn't set up on this server" })).toBe(
    "Nothing to show yet: 2 of its edits were written on an earlier version of the article. The one from a pull request can't be written again while AI isn't set up on this server: dismiss them.",
  );
  // Queued (the job writes it later): said so, until it shows.
  expect(nothingToShow(2, { ...can, rewritable: 2, writing: true })).toBe(
    "Nothing to show yet: 2 of its edits were written on an earlier version of the article. Writing them again… They show here once they're written.",
  );
  // Being written for a while (2 minutes): still.
  expect(nothingToShow(1, { ...can, writing: true, still: true })).toBe(
    "Nothing to show yet: its edit was written on an earlier version of the article. Still writing it again… It shows here once it's written.",
  );
  // Written again, and that failed: why, and Write it again to try once more.
  expect(nothingToShow(1, { ...can, failed: ["The AI provider didn't answer."] })).toBe(
    "Nothing to show yet: its edit was written on an earlier version of the article. It couldn't be written again. The AI provider didn't answer. Write it again to try once more, or dismiss it.",
  );
  // Others of its edits show: this one isn't among them.
  expect(nothingToShow(1, { ...can, of: 5 })).toBe(
    "One of its edits was written on an earlier version of the article, so it isn't in the changes below. Write it again to see what it changes, or dismiss it.",
  );
  // Its only one, below the team's own unpublished edit: not "one of" them.
  expect(nothingToShow(1, { ...can, of: 1 })).toBe(
    "Its edit was written on an earlier version of the article, so it isn't in the changes below. Write it again to see what it changes, or dismiss it.",
  );
  expect(nothingToShow(0, can)).toBe("Nothing to show: its unpublished changes are the same as the published article.");
});

test("an edit being written again is looked at every 3 seconds for 2 minutes, then every 15 seconds, never given up on", () => {
  expect([0, 1, 39].map(lookAgainIn)).toEqual([3_000, 3_000, 3_000]);
  expect([40, 41, 500].map(lookAgainIn)).toEqual([15_000, 15_000, 15_000]);
});

test("a post's review says what happens to its status", () => {
  expect(statusChange("moves_forward", "open")).toBe("Open → In progress");
  expect(statusChange("moves_forward", "planned")).toBe("Planned → In progress");
  expect(statusChange("moves_forward", "in_progress")).toBe("Stays In progress");
  expect(statusChange("resolves", "open")).toBe("Open → Completed");
  expect(statusChange("resolves", "completed")).toBe("Already completed");
});

test("a post's card says who stopped its update, a comment too long to post (Approve off until it's shortened), or why it waits", () => {
  const pending = (waitReason: string | null, kind = "moves_forward") => ({ kind, status: "pending", waitReason });
  // Who stopped it is its part, said with when it would have gone out.
  const stopped = { ...pending("Stopped by Sam"), wouldHaveGoneOutAt: "2026-11-03T20:25:00.000Z" };
  expect(postWaits({ kind: "resolves", parts: [pending("Autopilot asks first for these", "resolves"), stopped], text: "Out now.", commented: true, waitReason: "Autopilot asks first for these" })).toEqual({
    stopped,
    lines: ["Waits for you: Completing emails everyone on the post."],
    blocked: false,
  });
  // A completion with a progress update asked about first: the progress update's reason, in its words.
  expect(
    postWaits({ kind: "resolves", parts: [pending("Autopilot asks first for these"), pending(null, "resolves")], text: "Out now.", commented: true, waitReason: "Autopilot asks first for these" }).lines,
  ).toEqual(["Waits for you: Autopilot's settings ask first for progress updates."]);
  // How sure Autopilot is isn't said: nothing more than the bar's Approve.
  expect(postWaits({ kind: "moves_forward", parts: [pending("Less than 95% sure")], text: "Out now.", commented: true }).lines).toEqual([]);
  const long = "x".repeat(5_001);
  expect(postWaits({ kind: "moves_forward", parts: [pending(null)], text: long, commented: true, waitReason: "Its comment is too long to post (5,001 of 5,000 characters): shorten it" })).toEqual({
    lines: ["Its comment is too long to post (5,001 of 5,000 characters): shorten it."],
    blocked: true,
  });
  // Shortened in the box: it can go.
  expect(postWaits({ kind: "moves_forward", parts: [pending(null)], text: "Short now.", commented: true, waitReason: "Its comment is too long to post (5,001 of 5,000 characters): shorten it" })).toEqual({ lines: [], blocked: false });
  expect(postWaits({ kind: "moves_forward", parts: [pending(null)], text: " ", commented: true }).blocked).toBe(true);
  // A completion can go without its comment (one maybe already on the post): Approve stays on.
  expect(postWaits({ kind: "resolves", parts: [pending(null), pending(null, "resolves")], text: "", commented: true }).blocked).toBe(false);
  // One part sure, one not: the sure one's "another part waits" isn't said on the card, which lists no parts; the other's reason is.
  expect(postWaits({ kind: "moves_forward", parts: [pending("Another part of its update waits for you"), pending(null)], text: "Out now.", commented: true, waitReason: "Another part of its update waits for you" }).lines).toEqual([]);
  expect(
    postWaits({ kind: "moves_forward", parts: [pending("Another part of its update waits for you"), pending("Its post reaches 25 people or more")], text: "Out now.", commented: true, waitReason: "Another part of its update waits for you", reach: 41 }).lines,
  ).toEqual(["Waits for you: 41 people follow this post."]);
  // A completion with no comment to post: nothing to say, nothing in the way.
  expect(postWaits({ kind: "moves_forward", parts: [pending(null)], text: "", commented: false })).toEqual({ lines: [], blocked: false });
  expect(postWaits({ kind: "moves_forward", parts: [{ kind: "moves_forward", status: "dismissed", waitReason: "Stopped by Sam" }], text: "Out.", commented: true }).lines).toEqual([]);
});

test("a link still waiting, or the changelog line, isn't a review item; a link applied stays in its history", () => {
  expect(reviewItem({ kind: "links", status: "pending" })).toBe(false);
  expect(reviewItem({ kind: "links", status: "scheduled" })).toBe(false);
  expect(reviewItem({ kind: "links", status: "applied" })).toBe(true);
  expect(reviewItem({ kind: "changelog_line", status: "applied" })).toBe(false);
  expect(reviewItem({ kind: "moves_forward", status: "pending" })).toBe(true);
});

test("a part's chip says what became of it: Autopilot's own link, post update and article edit each in their words", () => {
  const applied = (kind: string, auto: boolean) => partState({ status: "applied", kind, auto, number: 7, decidedBy: auto ? null : "Sam" });
  expect(applied("links", true)).toBe("Linked by Autopilot");
  expect(applied("moves_forward", true)).toBe("Applied by Autopilot");
  expect(applied("resolves", true)).toBe("Applied by Autopilot");
  expect(applied("article_edit", true)).toBe("Published by Autopilot");
  expect(applied("moves_forward", false)).toBe("Approved by Sam");
  expect(partState({ status: "pending", kind: "moves_forward", auto: false, number: 7, waitReason: "Less than 95% sure" })).toBe("Waits for you");
  expect(partState({ status: "pending", kind: "article_edit", auto: false, number: 7, waitReason: "Its article was read 200 times or more in 30 days" }, 230)).toBe("Waits for you: Read 230 times in the last 30 days");
  expect(partState({ status: "dismissed", kind: "moves_forward", auto: false, number: 7, decidedBy: "Sam", dismissReason: "Not this time" })).toBe("Dismissed by Sam: Not this time");
});

test("How it's doing: nothing yet, one update, or several", () => {
  expect(autopilotRecordText({ kept: 0, of: 0, wentOut: false })).toMatch(/^Nothing has gone out yet\./);
  expect(autopilotRecordText({ kept: 0, of: 0, wentOut: true })).toMatch(/^Nothing it can count yet:/);
  expect(autopilotRecordText({ kept: 1, of: 1, wentOut: true })).toBe("Kept the one update it can count unchanged: not edited before approving, nor undone since.");
  expect(autopilotRecordText({ kept: 0, of: 1, wentOut: true })).toBe("The one update it can count was edited before approving, or undone since.");
  expect(autopilotRecordText({ kept: 3, of: 4, wentOut: true })).toBe("Kept 3 of its last 4 updates unchanged: not edited before approving, nor undone since.");
});

test("why an update waits, in plain words: never how sure Autopilot is, nor a setting's name; how many it reaches now", () => {
  expect(plainWhy("Less than 95% sure", "article_edit")).toBeNull();
  expect(plainWhy(null, "article_edit")).toBeNull();
  expect(plainWhy("Autopilot asks first for these", "resolves")).toBe("Completing emails everyone on the post");
  // Completing it emails nobody (a sample post, nobody who'd get it): the setting is what holds it.
  expect(plainWhy("Autopilot asks first for these", "resolves", null, 0)).toBe("Autopilot's settings ask first for completing posts");
  expect(plainWhy("Autopilot asks first for these", "moves_forward")).toBe("Autopilot's settings ask first for progress updates");
  // How many now (the stored reason names the setting it passed, which stays true as the number moves), else the setting.
  expect(plainWhy("Its post reaches 25 people or more", "moves_forward", 41)).toBe("41 people follow this post");
  expect(plainWhy("Its post reaches 25 people or more", "moves_forward")).toBe("25 people or more follow this post");
  expect(plainWhy("Its article was read 1 times or more in 30 days", "article_edit", 1)).toBe("Read 1 time in the last 30 days");
  // Fallen under the setting since (votes taken back, the 30 days moved on): the setting it passed, not a number that explains nothing.
  expect(plainWhy("Its article was read 200 times or more in 30 days", "article_edit", 4)).toBe("Read 200 times or more in the last 30 days");
  expect(plainWhy("Its post reaches 25 people or more", "moves_forward", 3)).toBe("25 people or more follow this post");
  // A setting of 1: in the singular.
  expect(plainWhy("Its post reaches 1 people or more", "moves_forward")).toBe("1 person or more follows this post");
  expect(plainWhy("Its article was read 1 times or more in 30 days", "article_edit")).toBe("Read 1 time or more in the last 30 days");
  expect(plainWhy("Its article was read 200 times or more in 30 days", "article_edit")).toBe("Read 200 times or more in the last 30 days");
  expect(plainWhy("Its article has a teammate's unpublished edit", "article_edit")).toBe("Its article has a teammate's unpublished edit");
});

describe("outcomeOf", () => {
  const decided = (kind: string, status: string, extra: Partial<{ auto: boolean; decidedBy: string | null; decidedAt: string; unpublished: boolean; unsure: boolean }> = {}) => ({
    kind,
    status,
    auto: false,
    decidedBy: "Olive Owner" as string | null,
    decidedAt: "2026-11-03T10:00:00.000Z",
    ...extra,
  });

  it("says what the applied updates did, in the past tense, and who approved them", () => {
    expect(outcomeOf([decided("links", "applied", { auto: true, decidedBy: null }), decided("resolves", "applied")])).toMatchObject({ outcome: "completed", line: "Approved by Olive" });
    expect(outcomeOf([decided("moves_forward", "applied")])).toMatchObject({ outcome: "in_progress", line: "Approved by Olive" });
  });

  it("says Autopilot published what went out by itself", () => {
    expect(outcomeOf([decided("article_edit", "applied", { auto: true, decidedBy: null })])).toMatchObject({ outcome: "published", line: "Published by Autopilot" });
  });

  it("says dismissed or undone when nothing went out, from the latest decided", () => {
    expect(outcomeOf([decided("resolves", "dismissed")])).toMatchObject({ outcome: "dismissed", line: "Dismissed by Olive" });
    expect(outcomeOf([decided("moves_forward", "undone"), decided("moves_forward", "dismissed")])).toMatchObject({ outcome: "undone", line: "Undone by Olive" });
  });

  it("never lets a link Autopilot applied by itself hide what the team decided", () => {
    const link = decided("links", "applied", { auto: true, decidedBy: null, decidedAt: "2026-11-03T09:00:00.000Z" });
    expect(outcomeOf([decided("resolves", "dismissed"), link])).toMatchObject({ outcome: "dismissed", line: "Dismissed by Olive" });
    expect(outcomeOf([decided("resolves", "undone"), link])).toMatchObject({ outcome: "undone" });
    expect(outcomeOf([link])).toMatchObject({ outcome: "linked", line: "Linked by Autopilot" });
  });

  it("credits whoever undid what Autopilot applied by itself, not Autopilot", () => {
    expect(outcomeOf([decided("article_edit", "undone", { auto: true })])).toMatchObject({ outcome: "undone", line: "Undone by Olive" });
  });

  it("says approved, not published, for an edit kept in the article's unpublished changes", () => {
    expect(outcomeOf([decided("article_edit", "applied", { unpublished: true })])).toMatchObject({ outcome: "approved", line: "Approved by Olive" });
  });

  it("says to check one Autopilot couldn't tell went out, whichever of its parts says so", () => {
    expect(outcomeOf([decided("article_edit", "applied", { decidedBy: null, unsure: true })])).toMatchObject({ outcome: "published", line: "Couldn't tell whether it went out: check it" });
    // A post's update: the completion (credited to the owner who claimed it) decides the outcome; its progress part is the unsure one.
    expect(outcomeOf([decided("resolves", "applied"), decided("moves_forward", "applied", { decidedBy: null, unsure: true })])).toMatchObject({
      outcome: "completed",
      line: "Couldn't tell whether it went out: check it",
      unsure: true,
    });
    // An older update's doubt says nothing of the completion approved later.
    expect(
      outcomeOf([decided("resolves", "applied", { decidedAt: "2026-11-03T12:00:00.000Z" }), decided("moves_forward", "applied", { decidedBy: null, unsure: true, decidedAt: "2026-11-01T10:00:00.000Z" })]),
    ).toMatchObject({ outcome: "completed", line: "Approved by Olive", unsure: false });
  });

  it("says what the latest decision did, not an older update's", () => {
    const old = decided("resolves", "applied", { decidedAt: "2026-01-10T10:00:00.000Z" });
    const latest = decided("moves_forward", "applied", { decidedAt: "2026-11-03T10:00:00.000Z" });
    expect(outcomeOf([latest, old])).toMatchObject({ outcome: "in_progress", by: latest });
    // Whatever order they come in.
    expect(outcomeOf([old, latest])).toMatchObject({ outcome: "in_progress", by: latest });
  });

  it("says what still stands when one of the edits published together is undone on its own", () => {
    const stays = decided("article_edit", "applied", { decidedAt: "2026-11-03T10:00:00.000Z" });
    const undone = decided("article_edit", "undone", { decidedAt: "2026-11-03T11:00:00.000Z" });
    expect(outcomeOf([undone, stays])).toMatchObject({ outcome: "published", by: stays });
  });

  it("has nothing to say with nothing decided", () => {
    expect(outcomeOf([])).toBeNull();
  });
});

describe("publishFirst", () => {
  it("asks to publish the same pull request's article first when completing the post emails people", () => {
    expect(publishFirst({ kind: "resolves", emails: 27 }, { kind: "article_edit" })).toBe(true);
  });

  it("doesn't when nobody is emailed, the update only moves it forward, or the other is a post or a new article's draft (approving it publishes nothing)", () => {
    expect(publishFirst({ kind: "resolves", emails: 0 }, { kind: "article_edit" })).toBe(false);
    expect(publishFirst({ kind: "moves_forward" }, { kind: "article_edit" })).toBe(false);
    expect(publishFirst({ kind: "resolves", emails: 3 }, { kind: "resolves" })).toBe(false);
    expect(publishFirst({ kind: "resolves", emails: 3 }, { kind: "new_article" })).toBe(false);
    // Out of date: it can't be published until it's written again.
    expect(publishFirst({ kind: "resolves", emails: 3 }, { kind: "article_edit", stale: true })).toBe(false);
    expect(publishFirst(null, { kind: "article_edit" })).toBe(false);
  });
});

describe("commentToApprove", () => {
  it("names a completion's comment as its box has it, empty for none, so apply never posts what was proposed", () => {
    expect(commentToApprove({ kind: "resolves" }, "")).toBe("");
    expect(commentToApprove({ kind: "resolves" }, "Dark is here.")).toBe("Dark is here.");
    expect(commentToApprove({ kind: "moves_forward" }, "Weekly repeats are out.")).toBe("Weekly repeats are out.");
    expect(commentToApprove({ kind: "links" }, "")).toBeUndefined();
  });
});

describe("a new article's draft's collection picker", () => {
  const offered = [":proposed", null, "billing", "guides"];
  test("keeps the team's pick on the draft and place it was made on", () => {
    expect(draftPick({ against: "d1 In Billing", value: "guides" }, "d1 In Billing", offered, ":proposed")).toBe("guides");
    expect(draftPick({ against: "d1 In Billing", value: null }, "d1 In Billing", offered, ":proposed")).toBeNull();
  });
  test("starts again on another draft, or the same draft with a new place", () => {
    expect(draftPick({ against: "d1 In Billing", value: "guides" }, "d2 In Billing", offered, ":proposed")).toBe(":proposed");
    expect(draftPick({ against: "d1 In Billing", value: null }, "d1 In a new collection, Exports", offered, ":proposed")).toBe(":proposed");
    // A draft with no place: no collection, as proposed.
    expect(draftPick({ against: "d1 In Billing", value: "guides" }, "d2 null", offered.slice(1), null)).toBeNull();
  });
  test("drops a pick the picker no longer offers (its collection deleted since)", () => {
    expect(draftPick({ against: "d1 In Billing", value: "guides" }, "d1 In Billing", [":proposed", null, "billing"], ":proposed")).toBe(":proposed");
  });
});

test("Undo on a new article's draft says the collection approving made goes too, when it does", () => {
  const draft = { id: "a1", kind: "new_article", number: 12 } as unknown as Parameters<typeof undoQuestion>[0];
  expect(undoQuestion(draft, []).description).toBe("The draft is deleted.");
  expect(undoQuestion({ ...draft, undoRemovesCollection: "Exports" }, []).description).toBe("The draft is deleted, and so is Exports, the collection approving it made.");
});
