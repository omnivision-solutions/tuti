import type { Doc } from "@tuti/content";
import { resetCodeChangesSettings } from "@tuti/shared";
import { afterEach, expect, test, vi } from "vitest";

import { EDIT_SYSTEM, REWRITE_RULE } from "./code-change-docs";
import { APPENDED_FAILS, appendedAtEnd, changelogWords, editScope, headingOverLittle, leftContradictions, renamed, ruleChecks, sizeOf, SMALL_WORDS } from "./edit-rules";
import { CHECK_UNCLEAR, checkedEdit, checkFailed, checksOn, readReview, REVIEW_SYSTEM, SCREENS_RULE } from "./edit-review";
import { CHECK_SYSTEM } from "./verify";

afterEach(() => vi.unstubAllEnvs());

const ARTICLE = "## Themes\n\nThe app has a light theme. Pick it in **Appearance**.\n\n## Fonts\n\nThe app uses one font.";

test("changelog words in what the edit wrote are found; the screen's own words, and 'new' and 'old', aren't", () => {
  expect(changelogWords(ARTICLE, ARTICLE.replace("The app has a light theme.", "The app no longer has only a light theme."))).toEqual([
    { word: "no longer", sentence: "The app no longer has only a light theme." },
  ]);
  expect(changelogWords(ARTICLE, ARTICLE.replace("The app has a light theme.", "You can now pick a dark theme.")).map((hit) => hit.word)).toEqual(["now"]);
  expect(changelogWords(ARTICLE, ARTICLE.replace("The app has a light theme.", "The theme was called Classic.")).map((hit) => hit.word)).toEqual(["was called"]);
  // A label that says it, "new" and "old", and a sentence the edit didn't write: nothing.
  expect(changelogWords(ARTICLE, ARTICLE.replace("The app has a light theme.", 'Click **Now** to create a new board, or open an old one.'))).toEqual([]);
  expect(changelogWords("You can now pick it.", "You can now pick it.")).toEqual([]);
});

test("text after the article's old last line is appended at the end; the last paragraph rewritten in place isn't", () => {
  expect(appendedAtEnd(ARTICLE, `${ARTICLE}\n\n## Dark theme\n\nThere's a dark theme too.`)).toEqual({ lines: ["## Dark theme", "There's a dark theme too."], heading: "Dark theme", subsection: false });
  // A subsection of the article's last section is no new section: a hint for the review, not a fail by itself.
  const sub = appendedAtEnd(ARTICLE, `${ARTICLE}\n\n### System font\n\nOr the system's.`);
  expect(sub).toEqual({ lines: ["### System font", "Or the system's."], heading: null, subsection: true });
  expect(ruleChecks(ARTICLE, `${ARTICLE}\n\n### System font\n\nOr the system's.`, { diff: "", added: false })).toMatchObject({ fails: null, hints: expect.arrayContaining([expect.stringContaining("Adds a subsection after the article's last line")]) });
  // Under a title (#) alone, a ## after the last line is a new section, not a subsection of the title.
  expect(appendedAtEnd("# Themes\n\nOne.", "# Themes\n\nOne.\n\n## Dark\n\nTwo.")).toMatchObject({ heading: "Dark", subsection: false });
  // In an article with no heading, any heading after its last line is a new section.
  expect(appendedAtEnd("One.\n\nTwo.", "One.\n\nTwo.\n\n### More\n\nThree.")).toMatchObject({ heading: "More" });
  expect(appendedAtEnd(ARTICLE, ARTICLE.replace("The app uses one font.", "The app uses one font, or the system's."))).toBeNull();
  expect(appendedAtEnd(ARTICLE, ARTICLE.replace("The app has a light theme.", "The app has a light theme and a dark one."))).toBeNull();
  // A last line repeated earlier, rewritten in place in the last section: nothing appended (the sections after the
  // earlier copy are the article's own).
  const steps = "## Light theme\n\nPick **Light** in **Appearance**.\n\nClick **Save**.\n\n## Dark theme\n\nPick **Dark** in **Appearance**.\n\nClick **Save**.";
  const applied = steps.replace(/Click \*\*Save\*\*\.$/, "Click **Apply**.");
  expect(appendedAtEnd(steps, applied)).toBeNull();
  expect(ruleChecks(steps, applied, { diff: "", added: false }).fails).toBeNull();
  // A line fixed in place and a section bolted on at the end that ends with the old last line: still appended.
  const one = "## Light theme\n\nPick **Light** in **Appearance**.\n\nClick **Save**.";
  const bolted = "## Light theme\n\nPick **Light** in **Settings**.\n\nClick **Save**.\n\n## Dark theme\n\nPick **Dark** in **Settings**.\n\nClick **Save**.";
  expect(appendedAtEnd(one, bolted)).toMatchObject({ heading: "Dark theme" });
  expect(ruleChecks(one, bolted, { diff: "", added: false }).fails).toBe(APPENDED_FAILS);
  // Nor does one whose new section ends like the line before the old last line.
  const note = "## Light theme\n\n1. Pick **Light** in **Appearance**.\n\n2. Click **Save**.\n\nThe theme changes right away.";
  const noted = "## Light theme\n\n1. Pick **Light** in **Settings**.\n\n2. Click **Save**.\n\nThe theme changes right away.\n\n## Dark theme\n\n1. Pick **Dark** in **Settings**.\n\n2. Click **Save**.";
  expect(appendedAtEnd(note, noted)).toMatchObject({ heading: "Dark theme" });
  expect(ruleChecks(note, noted, { diff: "", added: false }).fails).toBe(APPENDED_FAILS);
  // Lines it had, only moved to the end, aren't an addition.
  expect(appendedAtEnd("One.\n\nTwo.\n\nThree.", "Two.\n\nThree.\n\nOne.")).toBeNull();
});

test("a new heading over little text is found; one over a long section, or one the article had, isn't", () => {
  expect(headingOverLittle(ARTICLE, ARTICLE.replace("## Fonts", "## Dark theme\n\nPick Dark.\n\n## Fonts"))).toEqual([{ heading: "Dark theme", words: 2 }]);
  const long = Array.from({ length: 120 }, (_, i) => `word${i}`).join(" ");
  expect(headingOverLittle(ARTICLE, ARTICLE.replace("## Fonts", `## Dark theme\n\n${long}\n\n## Fonts`))).toEqual([]);
  expect(headingOverLittle(ARTICLE, ARTICLE.replace("The app uses one font.", "The app uses one font or two."))).toEqual([]);
});

test("size against the budget: a word-for-word fix is within it, a wall of text for a small change is past it", () => {
  expect(sizeOf(ARTICLE, ARTICLE.replace("**Appearance**", "**Display**"))).toEqual({ net: 0, overBudget: false });
  const wall = Array.from({ length: 70 }, (_, i) => `word${i}`).join(" ");
  expect(sizeOf(ARTICLE, ARTICLE.replace("The app uses one font.", `The app uses one font. ${wall}.`))).toMatchObject({ net: 70, overBudget: true });
  // A tenth of a short article, and over half the budget.
  const short = Array.from({ length: 35 }, (_, i) => `word${i}`).join(" ");
  expect(sizeOf(ARTICLE, ARTICLE.replace("The app uses one font.", `The app uses one font. ${short}.`)).overBudget).toBe(true);
});

test("old text the edit contradicts and leaves: a label it replaced once, one it names as old, one the code removed", () => {
  const twice = "## Themes\n\nPick it in **Appearance**.\n\n## Fonts\n\nFonts are in **Appearance** too.";
  // Renamed in one sentence, still in another.
  expect(leftContradictions(twice, twice.replace("Pick it in **Appearance**.", "Pick it in **Display**."), "")).toEqual([{ label: "Appearance", left: "Fonts are in **Appearance** too." }]);
  // Renamed everywhere: nothing left.
  expect(leftContradictions(twice, twice.replaceAll("**Appearance**", "**Display**"), "")).toEqual([]);
  // A label the pull request's diff took out of the screen, still in the article.
  const diff = '--- src/settings.tsx (modified)\n-  <Tab label="Appearance" />\n+  <Tab label="Display" />';
  expect(leftContradictions(twice, twice.replace("Pick it in **Appearance**.", "Pick it in the settings."), diff).map((hit) => hit.label)).toEqual(["Appearance"]);
  expect(leftContradictions(ARTICLE, ARTICLE.replace("The app uses one font.", "The app uses one font, as it did."), diff)).toEqual([{ label: "Appearance", left: "Pick it in **Appearance**." }]);
});

test("only a section appended at the end under a new heading fails an edit by itself, and not the section for the end the writer may add; the rest are hints", () => {
  expect(ruleChecks(ARTICLE, `${ARTICLE}\n\n## Dark theme\n\nThe app no longer has only a light theme.`, { diff: "", added: false })).toEqual({
    fails: APPENDED_FAILS,
    hints: ['Says how the product changed ("no longer") in “The app no longer has only a light theme.”.', "Adds the heading “Dark theme” over 9 words."],
  });
  expect(ruleChecks(ARTICLE, `${ARTICLE}\n\n## Dark theme\n\nThere's a dark theme.`, { diff: "", added: true })).toEqual({
    fails: null,
    hints: ["Adds the heading “Dark theme” over 4 words."],
  });
  // Text after the last line without a heading may be the last section's next step: a hint for the review.
  expect(ruleChecks(ARTICLE, `${ARTICLE}\n\nThere's a dark theme too.`, { diff: "", added: false })).toEqual({
    fails: null,
    hints: ["Adds text after the article's last line: “There's a dark theme too.”."],
  });
  expect(ruleChecks(ARTICLE, ARTICLE.replace("**Appearance**", "**Display**"), { diff: "", added: false })).toEqual({ fails: null, hints: [] });
});

test("the check is on for the projects AUTOPILOT_CHECKS_PROJECTS lists, or every project with *, and none when it's unset", () => {
  expect(checksOn("help")).toBe(false);
  vi.stubEnv("AUTOPILOT_CHECKS_PROJECTS", " Help , acme");
  expect([checksOn("help"), checksOn("acme"), checksOn("other"), checksOn("hel")]).toEqual([true, true, false, false]);
  vi.stubEnv("AUTOPILOT_CHECKS_PROJECTS", "*");
  expect(checksOn("other")).toBe(true);
  vi.stubEnv("AUTOPILOT_CHECKS_PROJECTS", "");
  expect(checksOn("help")).toBe(false);
});

const review = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    claims: [{ claim: "The tab is Display", check: "confirmed", evidence: "src/settings.tsx:3" }],
    accuracy: 5,
    needed: 5,
    placement: 5,
    voice: 5,
    proportion: 4,
    verdict: "accept",
    reasons: [],
    ...over,
  });

test("the review passes an edit only on accept, with scores and claims that agree", () => {
  expect(readReview(`Here: ${review()}`)).toEqual({
    pass: true,
    reasons: [],
    claims: [{ claim: "The tab is Display", check: "confirmed", evidence: "src/settings.tsx:3" }],
    scores: { accuracy: 5, needed: 5, placement: 5, voice: 5, proportion: 4 },
    verdict: "accept",
  });
  // touch_up is a fail (the looser pass let bad edits through), with the review's reasons; the first is the line it waits with.
  expect(readReview(review({ verdict: "touch_up", voice: 3, reasons: ["Drop “now” from “You can now pick”.", "Shorter."] }))).toMatchObject({
    pass: false,
    reason: "The check failed it: Drop “now” from “You can now pick”.",
    reasons: ["Drop “now” from “You can now pick”.", "Shorter."],
    verdict: "touch_up",
  });
  // Reasons that aren't text are left out; a fail with no reasons says which scores were low.
  expect(readReview(review({ verdict: "dismiss", needed: 1, reasons: [{ text: "Not needed." }] }))).toMatchObject({ pass: false, reasons: ["Its needed scored 1 of 5."] });
  expect(readReview(review({ verdict: "rewrite", placement: 1, reasons: [] }))).toMatchObject({ pass: false, reasons: ["Its placement scored 1 of 5."] });
  // An accept its own scores or claims contradict is a fail, saying why (its reasons, if any, were for an accept).
  expect(readReview(review({ needed: 3 }))).toMatchObject({ pass: false, reason: "The check failed it: Its needed scored 3 of 5.", verdict: "accept" });
  expect(readReview(review({ accuracy: 4, reasons: ["Fine."] }))).toMatchObject({ pass: false, reasons: ["Its accuracy scored 4 of 5."] });
  expect(readReview(review({ claims: [{ claim: "The tab is Display", check: "contradicted", evidence: "src/settings.tsx:3" }] }))).toMatchObject({
    pass: false,
    reasons: ["The code says otherwise: The tab is Display."],
  });
  // One that checked no claim at all isn't a pass, nor a fail a rewrite could act on: no review, so the edit waits.
  expect(readReview(review({ claims: [] }))).toBeNull();
  // So is one with a claim it couldn't find in the code: unverified isn't accurate enough to go out by itself.
  expect(readReview(review({ claims: [{ claim: "The tab is Display", check: "not_found", evidence: "searched Display" }] }))).toMatchObject({
    pass: false,
    reasons: ["The code doesn't show it: The tab is Display."],
  });
});

test("a review that can't be read is no review (the edit waits, it isn't rewritten)", () => {
  for (const reply of [
    "",
    "I think it's fine.",
    "{}",
    review({ verdict: "publish" }),
    review({ accuracy: 6 }),
    review({ accuracy: 4.5 }),
    review({ needed: "5" }),
    review({ claims: "none" }),
    // A claim that can't be read isn't dropped: the reply as a whole can't be trusted.
    review({ claims: [{ claim: "The tab is Display", check: "confirmed", evidence: "a:1" }, { claim: "The tab moved", check: "likely" }] }),
    review({ claims: [{ claim: "The tab is Display", check: "confirmed", evidence: "a:1" }, "the tab moved"] }),
    // Nor a claim with no text, or confirmed with nothing to show where.
    review({ claims: [{ claim: " ", check: "confirmed", evidence: "a:1" }] }),
    review({ claims: [{ claim: "The tab is Display", check: "confirmed" }] }),
    review({ claims: [{ claim: "The tab is Display", check: "confirmed", evidence: "  " }] }),
    // Turned down with nothing a rewrite could act on: no reasons (or none readable), and scores that would pass.
    review({ verdict: "touch_up", reasons: [] }),
    review({ verdict: "dismiss", proportion: 5, reasons: [{ text: "Not needed." }] }),
  ]) {
    expect(readReview(reply)).toBeNull();
  }
  expect(CHECK_UNCLEAR).toBe("The check didn't answer clearly");
  // The line it waits with stays one short line.
  expect(checkFailed("x ".repeat(200)).length).toBeLessThan(170);
});

test("Verify and the Checks review read screens and routes, not code comments; the writer is told how to take a fail", () => {
  expect(CHECK_SYSTEM).toContain(SCREENS_RULE);
  expect(REVIEW_SYSTEM).toContain(SCREENS_RULE);
  expect(EDIT_SYSTEM).toContain(REWRITE_RULE);
  // Pass means accept, and the rule checks are weighed, not copied.
  expect(REVIEW_SYSTEM).toContain('"verdict": "accept" | "touch_up" | "rewrite" | "dismiss"');
  expect(REVIEW_SYSTEM).toContain("each may or may not be a real problem");
});

// What may go out by itself (E6): a rename or moved page the code change shows, or a small correction in place.
const DIFF = '--- a/src/nav.tsx\n+++ b/src/nav.tsx\n-  <Link href="/settings/appearance">Customize</Link>\n+  <Link href="/settings/look">Look and feel</Link>';
const NAV = "## Themes\n\nOpen **Customize** and pick a theme.\n\n## Fonts\n\nFonts are in **Customize** too, at `/settings/appearance`.";

test("a rename: the old label in the diff's removed lines and the new one in its added lines, nothing else changed", () => {
  const after = NAV.replaceAll("**Customize**", "**Look and feel**");
  expect(renamed(NAV, after, DIFF)).toEqual({ from: ["Customize"], to: ["Look and feel"] });
  expect(editScope(NAV, after, DIFF)).toBe("rename");
  // A moved page: its path in `code`, as the diff has it.
  expect(renamed(NAV, NAV.replace("`/settings/appearance`", "`/settings/look`"), DIFF)).toEqual({ from: ["/settings/appearance"], to: ["/settings/look"] });
  // Case and markup as the code has them: "customize" in quotes, a label in bold.
  const lower = '-  label: "customize",\n+  label: "look and feel",';
  expect(renamed(NAV, after, lower)).not.toBeNull();
  // A heading renamed with it is still a rename.
  const titled = "## Customize\n\nOpen **Customize** to pick a theme.";
  expect(renamed(titled, "## Look and feel\n\nOpen **Look and feel** to pick a theme.", DIFF)).toEqual({ from: ["Customize"], to: ["Look and feel"] });
});

test("not a rename: one side missing from the diff, a label in a longer word, only one side in the edit, or other words changed too", () => {
  const after = NAV.replaceAll("**Customize**", "**Look and feel**");
  // The new label isn't in the added lines, or the old one isn't in the removed lines.
  expect(renamed(NAV, after, '-  <Link>Customize</Link>\n+  <Link>Settings</Link>')).toBeNull();
  expect(renamed(NAV, after, '-  <Link>Settings</Link>\n+  <Link>Look and feel</Link>')).toBeNull();
  // "Customize" only inside "Customized", in the context lines, or in a file's name: not removed.
  expect(renamed(NAV, after, '-  <p>Customized</p>\n+  <Link>Look and feel</Link>')).toBeNull();
  expect(renamed(NAV, after, '--- a/Customize.tsx\n+++ b/Customize.tsx\n   <Link>Customize</Link>\n+  <Link>Look and feel</Link>')).toBeNull();
  // A label taken out with none put in.
  expect(renamed(NAV, NAV.replace("Open **Customize** and pick a theme.", "Pick a theme."), DIFF)).toBeNull();
  // More than one name for one: two labels swapped, or two old names to two new ones (which became which can't be told).
  const TWO = "Open **Team** to send invites.\n\n**Members** lists who's in.";
  const swapDiff = "-  <Tab>Team</Tab>\n-  <Tab>Members</Tab>\n+  <Tab>Members</Tab>\n+  <Tab>Team</Tab>";
  expect(renamed(TWO, "Open **Members** to send invites.\n\n**Team** lists who's in.", swapDiff)).toBeNull();
  const twoDiff = "-  <Tab>Team</Tab>\n-  <Tab>Members</Tab>\n+  <Tab>People</Tab>\n+  <Tab>Roster</Tab>";
  expect(renamed(TWO, "Open **Roster** to send invites.\n\n**People** lists who's in.", twoDiff)).toBeNull();
  expect(editScope(TWO, "Open **Roster** to send invites.\n\n**People** lists who's in.", twoDiff)).not.toBe("rename");
  // Renamed, and a sentence changed besides.
  expect(renamed(NAV, after.replace("and pick a theme", "and pick one of three themes"), DIFF)).toBeNull();
});

test("not a rename: both labels on lines the diff changed for something else (kept on both sides)", () => {
  const before = "Open **Team** to send invites.";
  const after = "Open **Members** to send invites.";
  const icons = '-  <Tab>Team</Tab>\n-  <Tab>Members</Tab>\n+  <Tab icon="users">Team</Tab>\n+  <Tab icon="list">Members</Tab>';
  expect(renamed(before, after, icons)).toBeNull();
  expect(editScope(before, after, icons)).not.toBe("rename");
  // Either name on its other side, whatever its case, isn't one either.
  expect(renamed(before, after, "-  <Tab>Team</Tab>\n+  <Tab>Members</Tab>\n+  <p>team</p>")).toBeNull();
  expect(renamed(before, after, "-  <Tab>Team</Tab>\n-  <p>members</p>\n+  <Tab>Members</Tab>")).toBeNull();
  // A longer word holding a name on the other side doesn't count.
  expect(renamed(before, after, "-  <Tab>Team</Tab>\n+  <Tab>Members</Tab>\n+  <p>Teams</p>")).toEqual({ from: ["Team"], to: ["Members"] });
});

test("a small correction: in place, no heading touched, nothing appended, at most a couple of sentences either way", () => {
  const ARTICLE = "## Invites\n\nInvite links work for 3 days.\n\nSend a new one from **Team**.\n\n## Roles\n\nAdmins can invite people.";
  expect(editScope(ARTICLE, ARTICLE.replace("work for 3 days", "work for 7 days"), "")).toBe("correction");
  // Only adding text (a missing fact) isn't a correction in place.
  expect(editScope(ARTICLE, ARTICLE.replace("Admins can invite people.", "Admins can invite people. Members can't."), "")).toBe("larger");
  // A heading added, renamed or taken out.
  expect(editScope(ARTICLE, ARTICLE.replace("Invite links work for 3 days.", "Invite links work for 7 days.\n\n### Expiry\n\nThey expire."), "")).toBe("larger");
  expect(editScope(ARTICLE, ARTICLE.replace("## Roles", "## Who can invite").replace("Admins can", "Only admins can"), "")).toBe("larger");
  // Text appended after the article's last line (a sentence before it corrected too).
  expect(editScope(ARTICLE, `${ARTICLE.replace("3 days", "7 days")}\n\nOwners can too.`, "")).toBe("larger");
  // Past the words a small correction writes.
  const long = Array.from({ length: SMALL_WORDS + 1 }, (_, i) => `word${i}`).join(" ");
  expect(editScope(ARTICLE, ARTICLE.replace("Invite links work for 3 days.", `${long}.`), "")).toBe("larger");
  // Nothing taken out, or a rename the diff doesn't show and that rewrote more than a couple of sentences' words.
  expect(editScope(ARTICLE, ARTICLE, "")).toBe("larger");
});

test("without all of the change (a file left out or cut short), no edit is a rename: the name's other side may be in what's missing", () => {
  const before = "## Invite\n\nOpen **Team** to send invites.";
  const after = "## Invite\n\nOpen **Members** to send invites.";
  const diff = "--- src/tabs.tsx (modified, +1 -1)\n-  <Tab>Team</Tab>\n+  <Tab>Members</Tab>";
  expect(editScope(before, after, diff)).toBe("rename");
  expect(renamed(before, after, null)).toBeNull();
  expect(editScope(before, after, null)).toBe("correction");
});

test("a small correction counts what it takes out by occurrence: repeated sentences removed past the limit make it larger", () => {
  const repeated = Array.from({ length: 6 }, () => "Each invite link expires after three days unless the owner resends it.").join(" ");
  const before = `## Invite\n\nLinks last 3 days.\n\n${repeated}`;
  // One sentence corrected, and five of the six copies taken out: more than a small correction takes out.
  const after = "## Invite\n\nLinks last 7 days.\n\nEach invite link expires after three days unless the owner resends it.";
  expect(editScope(before, after, "")).toBe("larger");
  // The correction alone is still small.
  expect(editScope(before, before.replace("Links last 3 days.", "Links last 7 days."), "")).toBe("correction");
});

test("an edit that moves or copies text the article had is neither a rename nor a small correction", () => {
  const STEPS = "## Invite\n\n1. Remove the old member.\n2. Send the invite.\n\nLinks last 3 days.";
  // Steps swapped with a sentence corrected, or swapped alone.
  expect(editScope(STEPS, "## Invite\n\n1. Send the invite.\n2. Remove the old member.\n\nLinks last 7 days.", "")).toBe("larger");
  expect(editScope(STEPS, "## Invite\n\n1. Send the invite.\n2. Remove the old member.\n\nLinks last 3 days.", "")).toBe("larger");
  // A sentence the article already had, copied in with a correction.
  expect(editScope(STEPS, STEPS.replace("Links last 3 days.", "Links last 7 days. Send the invite."), "")).toBe("larger");
  // A label renamed, and a paragraph moved.
  const moved = "## Fonts\n\nFonts are in **Look and feel** too, at `/settings/appearance`.\n\n## Themes\n\nOpen **Look and feel** and pick a theme.";
  expect(renamed(NAV, moved, DIFF)).toBeNull();
  expect(editScope(NAV, moved, DIFF)).toBe("larger");
  // Two paragraphs that both carry the label, swapped while it's renamed; renamed in one place but left in another.
  const BOTH = "Open **Customize** and pick a theme.\n\nFonts are in **Customize** too.";
  expect(renamed(BOTH, "Fonts are in **Look and feel** too.\n\nOpen **Look and feel** and pick a theme.", DIFF)).toBeNull();
  expect(renamed(BOTH, "Open **Look and feel** and pick a theme.\n\nFonts are in **Customize** too.", DIFF)).toBeNull();
  // The same rename, one for one where they stand, is still one.
  expect(renamed(BOTH, "Open **Look and feel** and pick a theme.\n\nFonts are in **Look and feel** too.", DIFF)).toEqual({ from: ["Customize"], to: ["Look and feel"] });
});

test("the check stores an edit's scope from the pull request's diff only when that diff is all of the change: a cut one makes no rename", async () => {
  // Checks off: nothing is reviewed or asked, and the scope is stored all the same.
  vi.stubEnv("CODE_CHANGES_REDECIDE_MODEL", "off");
  resetCodeChangesSettings();
  const paragraph = (label: string): Doc => ({
    type: "doc",
    content: [{ type: "paragraph", content: [{ type: "text", text: "Open " }, { type: "text", text: label, marks: [{ type: "bold" }] }, { type: "text", text: " to send invites." }] }],
  });
  const written = { writtenOn: paragraph("Team"), doc: paragraph("Members"), reason: "The tab is Members now.", payload: { problem: "wrong" as const, title: "Invite", body: "", before: "", overview: "", overviewOf: [] }, reply: "" };
  const pr = { title: "Members", body: "", labels: [], author: "", mergedAt: "", mergeCommit: null, commits: [], files: [], diff: "--- src/tabs.tsx (modified, +1 -1)\n-  <Tab>Team</Tab>\n+  <Tab>Members</Tab>" };
  const review = { projectId: "p1", context: {} as never };
  const scope = async (diffComplete?: boolean) => ((await checkedEdit(async () => written, { ...pr, diffComplete }, review))!.payload as unknown as { check: { scope: string } }).check.scope;
  expect(await scope(true)).toBe("rename");
  expect(await scope(false)).not.toBe("rename");
  // A read from before the flag (unset) isn't known to be all of it.
  expect(await scope(undefined)).not.toBe("rename");
  resetCodeChangesSettings();
});
