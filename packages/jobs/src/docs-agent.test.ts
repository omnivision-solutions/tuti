import { afterEach, expect, test, vi } from "vitest";

import { decideDocs, outlineMarkdown } from "./docs-agent";

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
