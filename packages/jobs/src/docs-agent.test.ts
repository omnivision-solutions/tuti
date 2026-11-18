import { afterEach, expect, test, vi } from "vitest";

import { decideDocs, oneHome, outlineMarkdown, readDecision } from "./docs-agent";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

test("the outline: a line each, whatever a title or a name holds (a line break would start a heading or an item of its own)", () => {
  const outline = outlineMarkdown({
    collections: [{ id: "c1", slug: "billing", name: "Billing\n## Not a collection", parentId: null }],
    articles: [
      { id: "a1", slug: "invoices", title: "Invoices\n- not-an-article (fake)", publishedAt: new Date(), collectionId: "c1" },
      { id: "a2", slug: "refunds", title: "  Refunds \r\n soon ", publishedAt: null, collectionId: null },
    ],
    waiting: [{ id: "w1", title: "Exports\n\n## Not waiting" }],
    cap: 10,
  });
  expect(outline.split("\n")).toEqual([
    "## Billing ## Not a collection (billing)",
    "- Invoices - not-an-article (fake) (invoices)",
    "## Not in a collection",
    "- Refunds soon (refunds, draft)",
    "## New articles waiting for the team's approval",
    "- Exports ## Not waiting (new:w1)",
  ]);
});

test("the agent's first request: a new product area gets its own collection, and every changed file is listed with its size", async () => {
  vi.stubEnv("OPENAI_API_KEY", "sk-or-test");
  const bodies: { messages: { content: string }[] }[] = [];
  vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
    bodies.push(JSON.parse(String(init.body)) as (typeof bodies)[number]);
    return Response.json({ choices: [{ message: { content: JSON.stringify({ summary: "", edits: [], new_articles: [] }) } }] });
  });
  const pr = {
    ...{ title: "Dark mode", body: "", labels: [], author: "octo", mergedAt: "2026-11-06T10:00:00Z", mergeCommit: "abc", commits: [] },
    files: [
      { path: "pnpm-lock.yaml", status: "modified", additions: 900, deletions: 850, left: "lockfile" as const },
      { path: "src/theme.ts", status: "added", additions: 2, deletions: 0 },
    ],
    diff: "--- src/theme.ts (added, +2 -0)\n+export const dark = true;",
  };
  await decideDocs(pr, { projectId: "p1", repository: { unavailable: "test" } }, async () => {}, {
    fixture: { outline: "", articles: [], collections: [], run: async () => "" },
  });
  const [system, user] = bodies[0]!.messages;
  expect(system!.content).toContain("When the task belongs to a product area that no collection is about");
  expect(system!.content).toContain("propose a new collection named for that area, with a Lucide icon, rather than a loosely related existing one");
  const state = JSON.parse(user!.content.slice(0, user!.content.indexOf("\n\nThe help center"))) as { pull_request: { files: string[] } };
  expect(state.pull_request.files).toEqual(["pnpm-lock.yaml (modified, +900 -850, not shown: lockfile)", "src/theme.ts (added, +2 -0)"]);
});

const HELP_CENTER = {
  articles: ["team", "billing", "roles"].map((slug) => ({ id: `id-${slug}`, slug, publishedAt: new Date(), collectionId: null })),
  collections: [],
};
const FACTS = [
  { id: "f1", text: "Seats is called Members.", docs: "required" },
  { id: "f2", text: "Admins can export the member list as CSV.", docs: "optional" },
];
const read = (reply: Parameters<typeof readDecision>[0]) => readDecision(reply, "test-model", HELP_CENTER);
const edit = (slug: string, problem: string, facts: unknown, probability = 0.8) => ({ slug, problem, facts, probability, reason: `About ${slug}.` });

test("one home: a missing fact stays with the surest edit that names it (the first, when as sure); wrong edits are all kept", () => {
  const missing = (id: string, probability: number, ...facts: string[]) => ({ id, problem: "missing" as const, facts, probability });
  expect(oneHome([missing("a", 0.6, "export"), missing("b", 0.9, "export"), missing("c", 0.9, "export")]).map((e) => e.id)).toEqual(["b"]);
  // An edit that loses one of its facts keeps the others; one fact's home doesn't decide another's.
  expect(oneHome([missing("a", 0.9, "export", "invite"), missing("b", 0.7, "export", "roles"), missing("c", 0.5, "roles")])).toEqual([
    missing("a", 0.9, "export", "invite"),
    missing("b", 0.7, "roles"),
  ]);
  // Wrong text is corrected in every article that has it, and takes no missing fact's home.
  const wrong = (id: string, probability: number) => ({ id, problem: "wrong" as const, facts: ["rename"], probability });
  expect(oneHome([wrong("a", 0.9), wrong("b", 0.6), wrong("c", 0.9), missing("d", 0.5, "rename")]).map((e) => e.id)).toEqual(["a", "b", "c", "d"]);
  expect(oneHome([])).toEqual([]);
});

test("the agent's answer: each edit carries the facts it names, a missing fact has one home, and every wrong article keeps its correction", () => {
  const decision = read({
    summary: "Seats is Members.",
    facts: FACTS,
    edits: [edit("team", "wrong", ["f1", "f2"], 0.9), edit("billing", "obsolete", ["f1"], 0.7), edit("roles", "missing", ["f2"], 0.6)],
    new_articles: [{ title: "Export members", facts: ["f2"], probability: 0.4, reason: "Nothing covers it." }],
  });
  expect(decision.edits).toEqual([
    { articleId: "id-team", problem: "wrong", facts: ["Seats is called Members.", "Admins can export the member list as CSV."], probability: 0.9, reason: "About team." },
    { articleId: "id-billing", problem: "wrong", facts: ["Seats is called Members."], probability: 0.7, reason: "About billing." },
    { articleId: "id-roles", problem: "missing", facts: ["Admins can export the member list as CSV."], probability: 0.6, reason: "About roles." },
  ]);
  expect(decision.newArticles).toEqual([{ title: "Export members", probability: 0.4, reason: "Nothing covers it." }]);

  // An article named twice: one edit, the surest's verdict, number and reason, for the facts of both.
  expect(read({ facts: FACTS, edits: [edit("team", "missing", ["f2"], 0.4), edit("team", "wrong", ["f1", "f2"], 0.9), edit("team", "missing", ["f2"], 0.6)] }).edits).toEqual([
    { articleId: "id-team", problem: "wrong", facts: ["Admins can export the member list as CSV.", "Seats is called Members."], probability: 0.9, reason: "About team." },
  ]);
  // Wrong when any entry says so, even a less sure one: its correction isn't lost, nor given up to another article's home.
  expect(read({ facts: FACTS, edits: [edit("team", "missing", ["f2"], 0.9), edit("team", "wrong", ["f1"], 0.6), edit("billing", "missing", ["f1"], 0.95)] }).edits).toEqual([
    { articleId: "id-team", problem: "wrong", facts: ["Admins can export the member list as CSV.", "Seats is called Members."], probability: 0.9, reason: "About team." },
    { articleId: "id-billing", problem: "missing", facts: ["Seats is called Members."], probability: 0.95, reason: "About billing." },
  ]);

  const sameFact = read({ facts: FACTS, edits: [edit("team", "missing", ["f2"], 0.5), edit("billing", "missing", ["f2"], 0.8), edit("roles", "missing", ["f2"], 0.8)] });
  expect(sameFact.edits.map((e) => e.articleId)).toEqual(["id-billing"]);
});

test("the agent's answer: an edit or a new article that names no fact the answer lists is dropped, so one without facts proposes nothing", () => {
  const edits = [edit("team", "wrong", ["f1"]), edit("billing", "missing", ["f2"])];
  const newArticles = [{ title: "Export members", facts: ["f2"], probability: 0.9, reason: "Nothing covers it." }];
  // No facts, or a list that isn't one (the previous shape had no ids): nothing to write, so nothing is proposed.
  for (const facts of [undefined, [], "Seats is Members.", { f1: "Seats is Members." }, [null, "f1", 7, { text: "No id." }, { id: "f1" }, { id: "f1", text: "  " }, { id: 1, text: "Its id isn't text." }]]) {
    expect(read({ summary: "Seats is Members.", facts, edits, new_articles: newArticles })).toEqual({ summary: "Seats is Members.", edits: [], newArticles: [], model: "test-model" });
  }
  // A fact no edit names is nobody's; an id the answer doesn't list is left out, and an edit left with none is dropped.
  const decision = read({
    facts: [...FACTS, { id: "f3", text: "Nobody names this one." }, { id: "f1", text: "A second fact with the first's id." }],
    edits: [
      edit("team", "wrong", ["f1", "f9", "f1", 3, null]),
      edit("billing", "missing", ["f9"]),
      edit("roles", "missing", "f2"),
      { slug: "roles", problem: "missing", probability: 0.9, reason: "It names no facts at all." },
    ],
    new_articles: [
      { title: "Export members", facts: ["f9"], probability: 0.9, reason: "An id it doesn't list." },
      { title: "Members", probability: 0.9, reason: "No facts." },
    ],
  });
  expect(decision.edits).toEqual([{ articleId: "id-team", problem: "wrong", facts: ["Seats is called Members."], probability: 0.8, reason: "About team." }]);
  expect(decision.newArticles).toEqual([]);
});

test("the agent is told to list the facts a reader would miss, to give a missing fact one home, and to correct wrong text everywhere", async () => {
  vi.stubEnv("OPENAI_API_KEY", "sk-or-test");
  const systems: string[] = [];
  vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
    systems.push((JSON.parse(String(init.body)) as { messages: { content: string }[] }).messages[0]!.content);
    return Response.json({ choices: [{ message: { content: JSON.stringify({ summary: "", facts: [], edits: [], new_articles: [] }) } }] });
  });
  const pr = { title: "Members", body: "", labels: [], author: "octo", mergedAt: "2026-11-18T10:00:00Z", mergeCommit: "abc", commits: [], files: [], diff: "", diffComplete: true };
  await decideDocs(pr, { projectId: "p1", repository: { unavailable: "test" } }, async () => {}, { fixture: { outline: "", ...HELP_CENTER, run: async () => "" } });
  expect(systems[0]).toContain("Which facts would a reader of the help center miss, or be misled about?");
  expect(systems[0]).toContain("A fact that's missing gets one home: the one article a reader would look in first.");
  expect(systems[0]).toContain("Wrong text is corrected wherever it stands: every article that says it gets its edit, however many there are.");
  expect(systems[0]).toContain('"facts": [{"id": "f1", "text"');
  expect(systems[0]).toContain("when no article or draft is, the fact isn't an edit to the nearest one, it belongs in a new article (4).");
  expect(systems[0]).toContain("When you can't tell which (an article is near the task, not about it), name the fact for the edit and for the new article, each with its probability.");
  expect(systems[0]).toContain('"facts": ["<the id of each fact this edit is for: at least one>"]');
});
