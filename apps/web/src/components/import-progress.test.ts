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
  [...renderToStaticMarkup(createElement(ImportProgress, { projectSlug: "acme", run: r, invitations: 0 })).matchAll(/<li class="flex items-start[^"]*">(.*?)<\/li>(?=<li class="flex items-start|<\/ol>(?:<p|$))/g)].map((m) =>
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
    "Contacts 3 contacts Done",
    "Feedback Nothing new. Stopped",
    "Help center Collections and articles, with their images Not started",
  ]);
  // Done, each says so beside its link.
  expect(rows(run("done", null))[0]).toBe("Contacts Nothing new. Done See users");
});

test("a part going through what's already here counts it as it goes, so importing again visibly moves", () => {
  const counts = { contacts: { imported: 0, leftOut: { "already brought across earlier": 1300 } } };
  expect(rows(run("running", "contacts", counts))[0]).toBe("Contacts 1,300 skipped (brought earlier) so far In progress");
  expect(rows(run("running", "contacts", { contacts: { imported: 60, leftOut: { "already brought across earlier": 137_412 } } }))[0]).toBe(
    "Contacts 60 contacts 137,412 skipped (brought earlier) so far In progress",
  );
  // Only left out for other reasons: nothing new.
  expect(rows(run("running", "contacts", { contacts: { imported: 0, leftOut: { "without a name": 2 } } }))[0]).toMatch(/^Contacts Nothing new so far\. 2 left out/);
  // Under way with some brought: its numbers, so far.
  expect(rows(run("running", "votes", { posts: { imported: 4, leftOut: {} } }))[1]).toBe("Feedback 4 posts so far Posts (done) Votes (in progress) Comments Duplicate check In progress");
  // Only its own: the next part, with nothing counted yet, is starting.
  expect(rows(run("running", "posts", counts))[1]).toBe("Feedback Starting… Posts (in progress) Votes Comments Duplicate check In progress");
});

test("once done, each part shows its numbers and folds away what it left out and why; a part with no page shows no tag", () => {
  const counts = {
    posts: { imported: 218, leftOut: { "already brought across earlier": 281 } },
    comments: { imported: 253, leftOut: { "deleted or spam": 9, "with nothing left in them": 2 } },
    videos: { imported: 0, leftOut: { "Tuti has no place for": 1 } },
  };
  const r = { ...(run("done", null, counts) as object), parts: ["contacts", "feedback", "avatars"] } as unknown as Run;
  const html = renderToStaticMarkup(createElement(ImportProgress, { projectSlug: "acme", run: r, invitations: 0 }));
  expect(html).toMatch(/<span class="font-semibold tabular-nums">218<\/span> <span class="text-muted-foreground">posts<\/span>/);
  expect(html).toMatch(/<details[^>]*><summary[^>]*>12 left out<\/summary><ul[^>]*><li>9 comments deleted or spam<\/li><li>2 comments with nothing left in them<\/li><li>1 video Tuti has no place for<\/li><\/ul><\/details>/);
  // What an earlier import brought, skipped, apart from what came across and what was left out.
  expect(html).toMatch(/<span class="text-muted-foreground"><span class="tabular-nums">281<\/span> skipped \(brought earlier\)<\/span>/);
  // Its tick says it's done; a pill beside no link reads as a button, so only screen readers hear it.
  expect(html).not.toContain("rounded-full border");
  expect(html).toMatch(/Profile pictures<\/p>.*<span class="sr-only">Done<\/span><\/li><\/ol>/);
  expect(rows(r)).toEqual(["Contacts Nothing new. Done See users", expect.stringMatching(/^Feedback 218 posts 253 comments 281 skipped \(brought earlier\) 12 left out .* Done See feedback$/), "Profile pictures Nothing new. Done"]);
});

test("Home's button says View progress while it runs, View details after", () => {
  const button = (r: Run) => renderToStaticMarkup(createElement(ImportDetails, { projectSlug: "acme", run: r, invitations: 0 }));
  expect(button(run("running", "contacts"))).toContain("View progress");
  expect(button(run("done", null))).toContain("View details");
});
