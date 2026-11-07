import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, test, vi } from "vitest";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => {} }) }));
vi.mock("@/server/imports", () => ({}));

const { ImportDetails, ImportProgress } = await import("./setup-import");

type Run = Parameters<typeof ImportProgress>[0]["run"];
const run = (state: string, step: string | null, counts: object = {}) => ({ source: "featurebase", state, step, error: null, parts: ["contacts", "feedback", "docs"], counts }) as unknown as Run;
/** Each part's row as text, its tags and screen-reader text included. */
const rows = (r: Run) =>
  [...renderToStaticMarkup(createElement(ImportProgress, { projectSlug: "acme", run: r, invitations: 0 })).matchAll(/<li class="flex items-start[^"]*">(.*?)<\/li>(?=<li class="flex items-start|<\/ol>$)/g)].map((m) =>
    m[1]!.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim(),
  );

test("the part under way shows its steps: the done ones ticked, the current one marked for screen readers, the rest to come", () => {
  const html = renderToStaticMarkup(createElement(ImportProgress, { projectSlug: "acme", run: run("running", "votes"), invitations: 0 }));
  expect(html).toContain('aria-label="Feedback&#x27;s steps"');
  expect(html).toMatch(/<li aria-current="step"[^>]*>Votes<span class="sr-only"> \(in progress\)<\/span><\/li>/);
  expect(html).toMatch(/>Posts<span class="sr-only"> \(done\)<\/span>/);
  expect(html).toMatch(/border-dashed[^>]*>Comments<span class="sr-only"><\/span>/);
  // A part with one step has none.
  expect(renderToStaticMarkup(createElement(ImportProgress, { projectSlug: "acme", run: run("running", "contacts"), invitations: 0 }))).not.toContain("steps");
});

test("each part's tag: done, in progress, next, waiting; a failed import's stopped part and the ones it never started", () => {
  expect(rows(run("running", "contacts"))).toEqual([
    "Contacts Starting… In progress",
    "Feedback Boards, posts, votes and comments Next",
    "Help center Collections and articles, with their images Waiting",
  ]);
  expect(rows(run("failed", "posts", { contacts: { imported: 3, leftOut: {} } }))).toEqual([
    "Contacts 3 contacts. Done",
    "Feedback Nothing new. Stopped",
    "Help center Collections and articles, with their images Not started",
  ]);
  // Done, each says so beside its link.
  expect(rows(run("done", null))[0]).toBe("Contacts Nothing new. Done See users");
});

test("a part going through what's already here says so, not that it's starting", () => {
  const counts = { contacts: { imported: 0, leftOut: { "already brought across earlier": 1300 } } };
  expect(rows(run("running", "contacts", counts))[0]).toBe("Contacts Nothing new so far. Left out: 1,300 contacts already brought across earlier. In progress");
});

test("Home's button says View progress while it runs, View details after", () => {
  const button = (r: Run) => renderToStaticMarkup(createElement(ImportDetails, { projectSlug: "acme", run: r, invitations: 0 }));
  expect(button(run("running", "contacts"))).toContain("View progress");
  expect(button(run("done", null))).toContain("View details");
});
