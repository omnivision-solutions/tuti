import { afterEach, expect, test, vi } from "vitest";

import { EDIT_SYSTEM, REWRITE_RULE } from "./code-change-docs";
import { APPENDED_FAILS, appendedAtEnd, changelogWords, headingOverLittle, leftContradictions, ruleChecks, sizeOf } from "./edit-rules";
import { CHECK_UNCLEAR, checkFailed, checksOn, readReview, REVIEW_SYSTEM, SCREENS_RULE } from "./edit-review";
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
  // In an article with no heading, any heading after its last line is a new section.
  expect(appendedAtEnd("One.\n\nTwo.", "One.\n\nTwo.\n\n### More\n\nThree.")).toMatchObject({ heading: "More" });
  expect(appendedAtEnd(ARTICLE, ARTICLE.replace("The app uses one font.", "The app uses one font, or the system's."))).toBeNull();
  expect(appendedAtEnd(ARTICLE, ARTICLE.replace("The app has a light theme.", "The app has a light theme and a dark one."))).toBeNull();
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
