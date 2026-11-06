import { expect, test } from "vitest";

import { homeInvitationsToSend, importAt, importBrief, IMPORT_PARTS, importProgress, importSummary, kindCount, missingNeed, onHome, pickPart } from "./import-parts";

// The parts as the plan has them, Feedback and Inbox needing Contacts (only Contacts is built so far).
const parts = { contacts: { needs: [] }, feedback: { needs: ["contacts"] }, docs: { needs: [] }, inbox: { needs: ["contacts"] } };

test("ticking a part ticks what it needs; unticking one unticks what needs it", () => {
  expect(pickPart([], "feedback", true, parts)).toEqual(["contacts", "feedback"]);
  expect(pickPart(["docs"], "inbox", true, parts)).toEqual(["contacts", "docs", "inbox"]);
  expect(pickPart(["contacts", "feedback", "docs", "inbox"], "contacts", false, parts)).toEqual(["docs"]);
  expect(pickPart(["contacts", "feedback", "inbox"], "feedback", false, parts)).toEqual(["contacts", "inbox"]);
  expect(pickPart(["contacts"], "docs", true, parts)).toEqual(["contacts", "docs"]);
});

test("a picked part without what it needs is named", () => {
  expect(missingNeed(["feedback"], parts)).toEqual({ part: "feedback", need: "contacts" });
  expect(missingNeed(["contacts", "feedback", "inbox"], parts)).toBeNull();
  expect(missingNeed(["contacts"], IMPORT_PARTS)).toBeNull();
});

test("counts in words", () => {
  expect(kindCount("contacts", 1)).toBe("1 contact");
  expect(kindCount("contacts", 1200)).toBe("1,200 contacts");
});

test("an import's summary: what came across, what was left out and why, and why it stopped", () => {
  const run = { state: "done", counts: { contacts: { imported: 3, leftOut: {} } }, error: null } as never;
  expect(importSummary(run)).toBe("3 contacts brought across.");
  expect(importSummary({ state: "running", counts: {}, error: null } as never)).toBe("Starting…");
  // In the kinds' order, however the database ordered them.
  const counts = { contacts: { imported: 3, leftOut: {} }, attachments: { imported: 1, leftOut: {} }, conversations: { imported: 4, leftOut: {} } };
  expect(importSummary({ state: "done", counts, error: null } as never)).toBe("3 contacts, 4 conversations, 1 attachment brought across.");
  // In the kinds' order, whatever order the counts come in; a kind only left out isn't among what's brought.
  expect(
    importSummary({ state: "done", counts: { images: { imported: 0, leftOut: { "that couldn't be fetched": 1 } }, articles: { imported: 2, leftOut: {} }, collections: { imported: 1, leftOut: {} } }, error: null } as never),
  ).toBe("1 collection, 2 articles brought across. Left out: 1 image that couldn't be fetched.");
  expect(importSummary({ state: "failed", counts: { contacts: { imported: 1, leftOut: { "without a name": 2 } } }, error: "Featurebase couldn't be reached." } as never)).toBe(
    "1 contact brought across. Left out: 2 contacts without a name. Featurebase couldn't be reached.",
  );
  // In the import's order whatever order the counts are kept in; a kind only left out isn't said to be brought.
  const feedback = { notes: { imported: 1, leftOut: {} }, posts: { imported: 5, leftOut: {} }, images: { imported: 0, leftOut: { "too large": 1 } }, contacts: { imported: 3, leftOut: {} } };
  expect(importSummary({ state: "done", counts: feedback, error: null } as never)).toBe("3 contacts, 5 posts, 1 note brought across. Left out: 1 image too large.");
});

test("Home shows an import while it runs and for three days after it ended", () => {
  const now = Date.parse("2026-11-05T12:00:00Z");
  expect(onHome({ state: "running", finishedAt: null } as never, now)).toBe(true);
  expect(onHome({ state: "done", finishedAt: "2026-11-03T12:00:00Z" } as never, now)).toBe(true);
  expect(onHome({ state: "failed", finishedAt: "2026-11-02T11:00:00Z" } as never, now)).toBe(false);
});

test("each part's place: done before the step under way, the next one after it, the rest waiting; what each brought and left out", () => {
  const counts = {
    invitations: { imported: 2, leftOut: { "for people already invited": 1 } },
    contacts: { imported: 1300, leftOut: {} },
    posts: { imported: 4, leftOut: {} },
    images: { imported: 1, leftOut: {} },
    // The help center's images are its own, never feedback's.
    articleImages: { imported: 0, leftOut: { "too large": 2 } },
  };
  const run = (state: string, step: string | null) => ({ state, step, parts: ["inbox", "docs", "feedback", "contacts", "team"], counts }) as never;
  const states = (r: never) => importProgress(r).map(({ part, state }) => `${part} ${state}`);
  // In the order the import runs them, whatever order they were picked in.
  expect(states(run("running", "contacts"))).toEqual(["team done", "contacts now", "feedback next", "docs waiting", "inbox waiting"]);
  expect(importAt(run("running", "contacts"))).toBe("Part 2 of 5");
  // A part's later step is still that part.
  expect(states(run("running", "votes"))).toEqual(["team done", "contacts done", "feedback now", "docs next", "inbox waiting"]);
  expect(importProgress(run("running", "votes"))[2]).toMatchObject({ step: "votes", brought: "4 posts, 1 image", leftOut: "" });
  expect(importProgress(run("running", "docs-content"))[3]).toMatchObject({ state: "now", brought: "", leftOut: "2 images in articles too large" });
  // An import from before they were counted apart, without feedback: its images are the help center's.
  const older = { state: "done", step: null, parts: ["docs"], counts: { articles: { imported: 3, leftOut: {} }, images: { imported: 0, leftOut: { "too large": 1 } } } } as never;
  expect(importProgress(older)).toEqual([{ part: "docs", state: "done", step: null, brought: "3 articles", leftOut: "1 image too large" }]);
  expect(importProgress(run("running", "contacts"))[0]).toMatchObject({ brought: "2 invitations", leftOut: "1 invitation for people already invited" });
  // Failed, where it stopped; done, all of them.
  expect(states(run("failed", "posts"))).toEqual(["team done", "contacts done", "feedback stopped", "docs waiting", "inbox waiting"]);
  expect(importAt(run("failed", "posts"))).toBeNull();
  expect(states(run("done", null))).toEqual(["team done", "contacts done", "feedback done", "docs done", "inbox done"]);
});

test("an import in a line, as Home's card says it", () => {
  const counts = { contacts: { imported: 1300, leftOut: {} } };
  const run = (state: string, step: string | null, error: string | null = null) => ({ state, step, error, parts: ["team", "contacts", "feedback"], counts }) as never;
  expect(importBrief(run("running", "contacts"))).toBe("Part 2 of 3: Contacts, 1,300 contacts so far.");
  expect(importBrief(run("running", "posts"))).toBe("Part 3 of 3: Feedback, starting.");
  expect(importBrief(run("failed", "posts", "Featurebase couldn't be reached."))).toBe("Stopped at Feedback. Featurebase couldn't be reached.");
  // Only the parts that brought something.
  expect(importBrief(run("done", null))).toBe("Contacts brought across.");
  // Importing again: everything already here is left out, page after page, which isn't "starting".
  const again = (state: string, step: string | null) =>
    ({ state, step, error: null, parts: ["team", "contacts"], counts: { invitations: { imported: 0, leftOut: { x: 1 } }, contacts: { imported: 0, leftOut: { "already brought across earlier": 1300 } } } }) as never;
  expect(importBrief(again("running", "contacts"))).toBe("Part 2 of 2: Contacts, nothing new so far.");
  expect(importBrief(again("done", null))).toBe("Nothing new brought across.");
});

test("the team needs nothing, and nothing needs it: unticking Contacts leaves it ticked; its invitations are counted in words", () => {
  expect(IMPORT_PARTS.team.needs).toEqual([]);
  expect(pickPart(["team", "contacts", "feedback"], "contacts", false, IMPORT_PARTS)).toEqual(["team"]);
  expect(pickPart(["contacts"], "team", true, IMPORT_PARTS)).toEqual(["team", "contacts"]);
  expect(kindCount("invitations", 2)).toBe("2 invitations");
});

test("Home says how many invitations wait to be sent only to owners and admins (who can send them), once the import ended", () => {
  const run = (state: string) => ({ state, invitationsToSend: 2 }) as unknown as Parameters<typeof homeInvitationsToSend>[0];
  expect(homeInvitationsToSend(run("done"), true)).toBe(2);
  expect(homeInvitationsToSend(run("done"), false)).toBe(0);
  expect(homeInvitationsToSend(run("running"), true)).toBe(0);
});
