import { type Doc, toPlainText } from "@tuti/content";
import { docOf, hasTeammateEdit } from "@tuti/jobs";
import { prisma } from "@tuti/db";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

import TeamArticlePage from "@/app/app/[project]/docs/[slug]/page";
import { restoreArticle as restoreFromEditor, saveArticle } from "@/server/docs";

import { ARTICLE_REVISIONS_KEPT, createArticle, createCollection, deleteArticle, publishArticle, restoreArticle, updateArticle } from "@/server/operations/docs";
import { call } from "@/server/operations/run";
import { actAs, createProject, landArticleEdit, sectionsDoc, signUp, type TestUser } from "@/test/helpers";

/**
 * V3's save rules (docs/plan.md): while Autopilot's edits wait in an article's unpublished changes, a save says the
 * version it was made on (applied by section onto the newest, refused on the same section) and Restore says first
 * what it takes out.
 */

let owner: TestUser;
let project: Awaited<ReturnType<typeof createProject>>;

beforeEach(async () => {
  owner = await signUp("Olive Owner");
  project = await createProject(owner);
  actAs(owner);
});

afterEach(() => vi.restoreAllMocks());

const team = () => ({ actor: { kind: "user" as const, userId: owner.id }, projectId: project.id });

/** A published article in three sections. */
async function sectioned() {
  const created = await call(createArticle, team(), { title: "Change the theme", content: sectionsDoc("Themes change how the app looks.", ["Light", "Pick Light in Settings."], ["Dark", "Dark is coming."]) });
  await call(publishArticle, team(), { slug: created.slug });
  return prisma.article.findFirstOrThrow({ where: { projectId: project.id, slug: created.slug }, select: { id: true, slug: true } });
}
/** The text with one section's paragraph (by its heading, "" before the first) replaced. */
const rewrite = (heading: string, text: string) => (doc: Doc): Doc => {
  const blocks = [...(doc.content ?? [])];
  const at = heading === "" ? 0 : blocks.findIndex((block) => block.type === "heading" && toPlainText(block) === heading) + 1;
  blocks[at] = { type: "paragraph", content: [{ type: "text", text }] };
  return { type: "doc", content: blocks };
};
const newest = async (articleId: string) => (await prisma.articleRevision.findFirstOrThrow({ where: { articleId }, orderBy: [{ createdAt: "desc" }, { id: "desc" }] })).id;
const changes = async (articleId: string) => (await prisma.articleChanges.findUnique({ where: { articleId }, select: { body: true } }))?.body ?? null;
const statusOf = async (id: string) => (await prisma.codeChangeAction.findUniqueOrThrow({ where: { id } })).status;
const START = sectionsDoc("Themes change how the app looks.", ["Light", "Pick Light in Settings."], ["Dark", "Dark is coming."]);

test("a save made before a pull request's edit: applied by section onto it when they changed other sections, the edit kept", async () => {
  const article = await sectioned();
  const opened = await newest(article.id);
  const edit = await landArticleEdit(project.id, article.id, 61, rewrite("Light", "Pick Light or Dark in Settings."));
  await call(updateArticle, team(), { slug: article.slug, content: rewrite("Dark", "Dark is here, in Settings.")(START), revision: opened });
  expect(await changes(article.id)).toBe("Themes change how the app looks.\nLight\nPick Light or Dark in Settings.\nDark\nDark is here, in Settings.");
  expect(await statusOf(edit.id)).toBe("PENDING");
});

test("a save made before a pull request's edit to the same section is refused (409), saying so; nothing is saved", async () => {
  const article = await sectioned();
  const opened = await newest(article.id);
  await landArticleEdit(project.id, article.id, 62, rewrite("Light", "Pick Light or Dark in Settings."));
  await expect(call(updateArticle, team(), { slug: article.slug, content: rewrite("Light", "Pick Light, always.")(START), revision: opened })).rejects.toMatchObject({
    status: 409,
    code: "autopilot_changed",
  });
  expect(await changes(article.id)).toBe("Themes change how the app looks.\nLight\nPick Light or Dark in Settings.\nDark\nDark is coming.");
});

test("an API save with no revision is refused while an edit waits; with the newest, or with none waiting, it saves", async () => {
  const article = await sectioned();
  // Nothing waits: as before, no revision needed.
  await call(updateArticle, team(), { slug: article.slug, content: rewrite("", "Themes change everything.")(START) });
  await landArticleEdit(project.id, article.id, 63, rewrite("Light", "Pick Light or Dark in Settings."));
  await expect(call(updateArticle, team(), { slug: article.slug, body: "Start again." })).rejects.toMatchObject({ status: 409, code: "revision_required" });
  // Not the text: the title alone changes nothing of the edit's.
  await call(updateArticle, team(), { slug: article.slug, title: "Themes" });
  const saved = await prisma.articleChanges.findUniqueOrThrow({ where: { articleId: article.id }, select: { content: true, body: true } });
  await call(updateArticle, team(), { slug: article.slug, content: rewrite("Dark", "Dark is here.")(saved.content as Doc), revision: await newest(article.id) });
  expect(await changes(article.id)).toBe("Themes change everything.\nLight\nPick Light or Dark in Settings.\nDark\nDark is here.");
});

test("a save made before a teammate's save is refused as before, Autopilot's edit or not", async () => {
  const article = await sectioned();
  const opened = await newest(article.id);
  await call(updateArticle, team(), { slug: article.slug, content: rewrite("", "Themes change everything.")(START), revision: opened });
  await landArticleEdit(project.id, article.id, 64, rewrite("Light", "Pick Light or Dark in Settings."));
  await expect(call(updateArticle, team(), { slug: article.slug, content: rewrite("Dark", "Dark is here.")(START), revision: opened })).rejects.toMatchObject({
    status: 409,
    code: "changed",
  });
});

test("Restore while edits wait says first which it takes out (409), and with dismissEdits dismisses those, keeping the rest", async () => {
  const article = await sectioned();
  // The version to restore: the opening rewritten (it has neither edit's sections changed).
  await call(updateArticle, team(), { slug: article.slug, content: rewrite("", "Themes change everything.")(START), revision: await newest(article.id) });
  const restoreTo = await newest(article.id);
  const light = await landArticleEdit(project.id, article.id, 65, rewrite("Light", "Pick Light or Dark in Settings."));
  // Restoring the version before both edits takes them out.
  await expect(call(restoreArticle, team(), { slug: article.slug, revision: restoreTo })).rejects.toMatchObject({
    status: 409,
    code: "edits_waiting",
    message: `Restoring this version takes out PR #65's edit, which waits in the unpublished changes: it's dismissed if you restore it (dismissEdits: ${light.id})`,
  });
  expect(await statusOf(light.id)).toBe("PENDING");
  // A version that has an edit's sections as the edit wrote them keeps it.
  const dark = await landArticleEdit(project.id, article.id, 66, rewrite("Dark", "Dark is here."));
  const withBoth = await newest(article.id);
  await call(updateArticle, team(), { slug: article.slug, title: "Themes" });
  await call(restoreArticle, team(), { slug: article.slug, revision: withBoth });
  expect([await statusOf(light.id), await statusOf(dark.id)]).toEqual(["PENDING", "PENDING"]);
  // Confirming only the one named before: the other, landed since, is named again, and nothing is restored.
  await expect(call(restoreArticle, team(), { slug: article.slug, revision: restoreTo, dismissEdits: [light.id] })).rejects.toMatchObject({
    code: "edits_waiting",
    message: expect.stringContaining("Restoring this version takes out the edits of PR #65, PR #66, which wait in the unpublished changes: they're dismissed if you restore it") as string,
  });
  expect([await statusOf(light.id), await statusOf(dark.id)]).toEqual(["PENDING", "PENDING"]);
  await call(restoreArticle, team(), { slug: article.slug, revision: restoreTo, dismissEdits: [light.id, dark.id] });
  expect([await statusOf(light.id), await statusOf(dark.id)]).toEqual(["DISMISSED", "DISMISSED"]);
  expect((await prisma.codeChangeAction.findUniqueOrThrow({ where: { id: light.id } })).dismissReason).toBe("Taken out by restoring an earlier version");
  expect(await changes(article.id)).toBe("Themes change everything.\nLight\nPick Light in Settings.\nDark\nDark is coming.");
});

test("after a refusal, a save that saw the newest version keeps Autopilot's edits elsewhere: the teammate's text wins only where both changed", async () => {
  const article = await sectioned();
  const opened = await newest(article.id);
  // One pull request's edit changes Light and Dark; another's only the opening.
  const both = await landArticleEdit(project.id, article.id, 67, (doc) => rewrite("Dark", "Dark is here.")(rewrite("Light", "Pick Light or Dark in Settings.")(doc)));
  const opening = await landArticleEdit(project.id, article.id, 68, rewrite("", "Themes change everything."));
  const mine = rewrite("Light", "Pick Light, always.")(START);
  await expect(call(updateArticle, team(), { slug: article.slug, content: mine, revision: opened })).rejects.toMatchObject({ code: "autopilot_changed" });
  // Shown the newest, they save again (on the version they opened, having seen that one).
  await call(updateArticle, team(), { slug: article.slug, content: mine, revision: opened, seen: await newest(article.id) });
  expect(await changes(article.id)).toBe("Themes change everything.\nLight\nPick Light, always.\nDark\nDark is here.");
  // (PR #67's Dark is still in the changes: it keeps waiting, under the teammate's Light.)
  expect([await statusOf(both.id), await statusOf(opening.id)]).toEqual(["PENDING", "PENDING"]);
});

test("a save that saw an older newest version is checked again: another edit landed since is merged by section or refused", async () => {
  const article = await sectioned();
  const opened = await newest(article.id);
  await landArticleEdit(project.id, article.id, 69, rewrite("Light", "Pick Light or Dark in Settings."));
  const seen = await newest(article.id);
  await landArticleEdit(project.id, article.id, 70, rewrite("Light", "Pick Light, Dark or System in Settings."));
  await expect(call(updateArticle, team(), { slug: article.slug, content: rewrite("Light", "Pick Light, always.")(START), revision: opened, seen })).rejects.toMatchObject({
    code: "autopilot_changed",
  });
});

test("the teammate's own change of collection (no new text) since the editor opened doesn't make its text save a 409", async () => {
  const article = await sectioned();
  const opened = await newest(article.id);
  await landArticleEdit(project.id, article.id, 71, rewrite("Light", "Pick Light or Dark in Settings."));
  const collection = await call(createCollection, team(), { name: "Appearance" });
  await call(updateArticle, team(), { slug: article.slug, collection: collection.slug });
  await call(updateArticle, team(), { slug: article.slug, content: rewrite("Dark", "Dark is here.")(START), revision: opened });
  expect(await changes(article.id)).toBe("Themes change how the app looks.\nLight\nPick Light or Dark in Settings.\nDark\nDark is here.");
});

test("after a refusal, a save that saw the newest version and moves sections around goes in whole, never refused again", async () => {
  const article = await sectioned();
  const opened = await newest(article.id);
  await landArticleEdit(project.id, article.id, 72, rewrite("Light", "Pick Light or Dark in Settings."));
  // Dark before Light, and Light rewritten.
  const moved = sectionsDoc("Themes change how the app looks.", ["Dark", "Dark is coming."], ["Light", "Pick Light, always."]);
  await expect(call(updateArticle, team(), { slug: article.slug, content: moved, revision: opened })).rejects.toMatchObject({ code: "autopilot_changed" });
  await call(updateArticle, team(), { slug: article.slug, content: moved, revision: opened, seen: await newest(article.id) });
  expect(await changes(article.id)).toBe("Themes change how the app looks.\nDark\nDark is coming.\nLight\nPick Light, always.");
});

test("a save says the version it left newest, and whether it merged the text onto Autopilot's edits (so an editor still typing stays on its own version)", async () => {
  const article = await sectioned();
  const plain = await call(updateArticle, team(), { slug: article.slug, content: rewrite("", "Themes change everything.")(START), revision: await newest(article.id) });
  expect(plain).toMatchObject({ revision: await newest(article.id), merged: false });
  const opened = await newest(article.id);
  await landArticleEdit(project.id, article.id, 73, rewrite("Light", "Pick Light or Dark in Settings."));
  const merged = await call(updateArticle, team(), { slug: article.slug, content: rewrite("Dark", "Dark is here.")(rewrite("", "Themes change everything.")(START)), revision: opened });
  expect(merged).toMatchObject({ revision: await newest(article.id), merged: true });
});

test("the newest version shown after a refused save pairs its text with a revision no newer than it: a save landing as it's read can't be written over unseen", async () => {
  const article = await sectioned();
  const opened = await newest(article.id);
  await landArticleEdit(project.id, article.id, 74, rewrite("Light", "Pick Light or Dark in Settings."));
  // As the editor's refusal reads the newest version, another edit lands.
  const find = prisma.articleRevision.findFirst.bind(prisma.articleRevision) as (...args: unknown[]) => Promise<unknown>;
  let landed = false;
  vi.spyOn(prisma.articleRevision, "findFirst").mockImplementation((async (...args: unknown[]) => {
    const query = args[0] as { where?: { articleId?: string } };
    if (!landed && query.where?.articleId === article.id) {
      landed = true;
      await landArticleEdit(project.id, article.id, 75, rewrite("Dark", "Dark is here."));
    }
    return find(...args);
  }) as never);
  const form = new FormData();
  form.set("title", "Change the theme");
  form.set("content", JSON.stringify(rewrite("Light", "Pick Light, always.")(START)));
  form.set("revision", opened);
  const result = await saveArticle(project.slug, article.slug, {}, form);
  vi.restoreAllMocks();
  expect(landed).toBe(true);
  expect(result.newest).toBeDefined();
  // Shown with the newest revision, it shows the newest text (the edit that landed included); else an older revision.
  if (result.newest!.revision === (await newest(article.id))) {
    expect(JSON.stringify(result.newest!.content)).toContain("Dark is here.");
  }
});

test("Restore's confirmation names the edits it takes out on a deleted article too (as the restore finds it), never none", async () => {
  const article = await sectioned();
  const before = await newest(article.id);
  const edit = await landArticleEdit(project.id, article.id, 76, rewrite("Light", "Pick Light or Dark in Settings."));
  await call(deleteArticle, team(), { slug: article.slug });
  const result = await restoreFromEditor(project.slug, article.slug, before);
  expect(result.confirm).toEqual({
    message: "Restoring this version takes out PR #76's edit, which waits in the unpublished changes: it's dismissed if you restore it",
    edits: [edit.id],
  });
});

test("an edit a later one rewrote on the same section isn't taken out by text that leaves that section as it is now (Restore, and a save that saw the newest)", async () => {
  const article = await sectioned();
  const opened = await newest(article.id);
  // PR #77 changes Light; PR #78, written on it, changes Light again.
  const first = await landArticleEdit(project.id, article.id, 77, rewrite("Light", "Pick Light or Dark in Settings."));
  const second = await landArticleEdit(project.id, article.id, 78, rewrite("Light", "Pick Light, Dark or System in Settings."));
  const layered = await newest(article.id);
  await call(updateArticle, team(), { slug: article.slug, title: "Themes" });
  // Restoring the text as it is now takes nothing out.
  await call(restoreArticle, team(), { slug: article.slug, revision: layered });
  expect([await statusOf(first.id), await statusOf(second.id)]).toEqual(["PENDING", "PENDING"]);
  // A save that saw the newest and changed only the opening dismisses neither.
  await call(updateArticle, team(), { slug: article.slug, content: rewrite("", "Themes change everything.")(START), revision: opened, seen: await newest(article.id) });
  expect([await statusOf(first.id), await statusOf(second.id)]).toEqual(["PENDING", "PENDING"]);
  expect(await changes(article.id)).toBe("Themes change everything.\nLight\nPick Light, Dark or System in Settings.\nDark\nDark is coming.");
});

test("an article saved before revisions existed: the editor's save (no version) is refused while an edit waits, then saved once it saw the newest", async () => {
  const created = await prisma.article.create({
    data: { projectId: project.id, slug: "old-theme", title: "Change the theme", body: toPlainText(START), content: START, publishedAt: new Date() },
    select: { id: true, slug: true },
  });
  const edit = await landArticleEdit(project.id, created.id, 79, rewrite("Light", "Pick Light or Dark in Settings."));
  const form = new FormData();
  form.set("title", "Change the theme");
  form.set("content", JSON.stringify(rewrite("Light", "Pick Light, always.")(START)));
  // (The editor opened with no version: its revision field is empty.)
  form.set("revision", "");
  const refused = await saveArticle(project.slug, created.slug, {}, form);
  expect(refused.error).toBe("Autopilot changed the article since you opened it. Your text is kept: compare it with the newest version, then save again.");
  expect(refused.newest?.revision).toBe(await newest(created.id));
  form.set("seen", refused.newest!.revision!);
  expect((await saveArticle(project.slug, created.slug, refused, form)).error).toBeUndefined();
  expect(await changes(created.id)).toBe("Themes change how the app looks.\nLight\nPick Light, always.\nDark\nDark is coming.");
  expect((await prisma.codeChangeAction.findUniqueOrThrow({ where: { id: edit.id } })).dismissReason).toBe("Replaced in the editor");
});

test("a save made on the newest version is a teammate's edit on top: a one-word fix in an edit's section keeps it waiting, to approve together", async () => {
  const article = await sectioned();
  const light = await landArticleEdit(project.id, article.id, 80, rewrite("Light", "Pick Light or Dark in Settings."));
  const saved = async () => docOf(await prisma.articleChanges.findUniqueOrThrow({ where: { articleId: article.id } }));
  // The teammate opened the editor on the newest (the edit in front of them) and fixes one word in its section.
  await call(updateArticle, team(), { slug: article.slug, content: rewrite("Light", "Pick Light or Dark in Preferences.")(await saved()), revision: await newest(article.id) });
  expect(await statusOf(light.id)).toBe("PENDING");
  expect(await hasTeammateEdit(article.id)).toBe(true);
  expect(await changes(article.id)).toBe("Themes change how the app looks.\nLight\nPick Light or Dark in Preferences.\nDark\nDark is coming.");
});

test("after a save that merged, its own revision isn't taken for someone else's: an edit landing after it is layered on the next save", async () => {
  const article = await sectioned();
  const opened = await newest(article.id);
  await landArticleEdit(project.id, article.id, 82, rewrite("Light", "Pick Light or Dark in Settings."));
  // The teammate's save (Dark), made on the version they opened: merged onto the edit.
  const mine = rewrite("Dark", "Dark is here.")(START);
  const first = await call(updateArticle, team(), { slug: article.slug, content: mine, revision: opened });
  expect(first.merged).toBe(true);
  // Another edit lands (the opening) while they keep typing (a new section).
  await landArticleEdit(project.id, article.id, 83, rewrite("", "Themes change everything."));
  const more: Doc = { type: "doc", content: [...(mine.content ?? []), ...(sectionsDoc(["System", "Follows the device."]).content ?? [])] };
  const second = await call(updateArticle, team(), { slug: article.slug, content: more, revision: opened, own: first.revision! });
  expect(await changes(article.id)).toBe("Themes change everything.\nLight\nPick Light or Dark in Settings.\nDark\nDark is here.\nSystem\nFollows the device.");
  // Changing a section an edit landing since changed is refused as Autopilot's change, never "someone saved".
  await landArticleEdit(project.id, article.id, 84, rewrite("Light", "Pick Light, Dark or System in Settings."));
  await expect(
    call(updateArticle, team(), { slug: article.slug, content: rewrite("Light", "Pick Light, always.")(more), revision: opened, own: second.revision! }),
  ).rejects.toMatchObject({ code: "autopilot_changed" });
});

test("the article's page reads the editor's version before its text: an edit landing between leaves the text newer than the version, never older", async () => {
  const article = await sectioned();
  const revisionRead = vi.spyOn(prisma.articleRevision, "findFirst");
  const textRead = vi.spyOn(prisma.article, "findFirst");
  await TeamArticlePage({ params: Promise.resolve({ project: project.slug, slug: article.slug }), searchParams: Promise.resolve({}) } as never);
  const version = revisionRead.mock.calls.findIndex(([query]) => JSON.stringify(query).includes(article.slug));
  const text = textRead.mock.calls.findIndex(([query]) => JSON.stringify(query).includes(article.slug));
  expect(version).not.toBe(-1);
  expect(revisionRead.mock.invocationCallOrder[version]).toBeLessThan(textRead.mock.invocationCallOrder[text]!);
});

test("after a save that merged, going on typing in one's own section isn't a conflict when another edit lands elsewhere", async () => {
  const article = await sectioned();
  const opened = await newest(article.id);
  // PR #85 changes Dark; the teammate saves Light (merged onto it) and keeps typing in Light.
  await landArticleEdit(project.id, article.id, 85, rewrite("Dark", "Dark is here."));
  const first = await call(updateArticle, team(), { slug: article.slug, content: rewrite("Light", "Pick Light.")(START), revision: opened });
  expect(first.merged).toBe(true);
  // PR #86 changes the opening.
  await landArticleEdit(project.id, article.id, 86, rewrite("", "Themes change everything."));
  const second = await call(updateArticle, team(), { slug: article.slug, content: rewrite("Light", "Pick Light, the default.")(START), revision: opened, own: first.revision! });
  expect(await changes(article.id)).toBe("Themes change everything.\nLight\nPick Light, the default.\nDark\nDark is here.");
  // Changing PR #85's section, merged in by their save, is still refused as Autopilot's.
  await expect(
    call(updateArticle, team(), { slug: article.slug, content: rewrite("Dark", "Dark, soon.")(rewrite("Light", "Pick Light, the default.")(START)), revision: opened, own: second.revision! }),
  ).rejects.toMatchObject({ code: "autopilot_changed" });
});

test("a save that overwrites one of an edit's two sections keeps it waiting (its other section is still in the changes): replaced only when all are", async () => {
  const article = await sectioned();
  const opened = await newest(article.id);
  const both = await landArticleEdit(project.id, article.id, 88, (doc) => rewrite("Dark", "Dark is here.")(rewrite("Light", "Pick Light or Dark in Settings.")(doc)));
  const mine = rewrite("Light", "Pick Light, always.")(START);
  await expect(call(updateArticle, team(), { slug: article.slug, content: mine, revision: opened })).rejects.toMatchObject({ code: "autopilot_changed" });
  await call(updateArticle, team(), { slug: article.slug, content: mine, revision: opened, seen: await newest(article.id) });
  expect(await statusOf(both.id)).toBe("PENDING");
  expect(await changes(article.id)).toBe("Themes change how the app looks.\nLight\nPick Light, always.\nDark\nDark is here.");
  // Both its sections replaced: dismissed.
  const opened2 = await newest(article.id);
  const again = await landArticleEdit(project.id, article.id, 89, rewrite("", "Themes change everything."));
  await call(updateArticle, team(), { slug: article.slug, content: rewrite("", "Themes, in short.")(docOf(await prisma.articleChanges.findUniqueOrThrow({ where: { articleId: article.id } }))), revision: opened2, seen: await newest(article.id) });
  expect(await statusOf(again.id)).toBe("DISMISSED");
});

test("an editor whose version was pruned isn't stuck: refused once, then its save that saw the newest goes in", async () => {
  const article = await sectioned();
  const opened = await newest(article.id);
  // More than are kept saved since (titles only), and nothing tagged keeps the editor's version.
  for (let n = 1; n <= ARTICLE_REVISIONS_KEPT + 1; n++) {
    await call(updateArticle, team(), { slug: article.slug, title: `Change the theme ${n}` });
  }
  expect(await prisma.articleRevision.count({ where: { id: opened } })).toBe(0);
  const mine = rewrite("Dark", "Dark is here.")(START);
  await expect(call(updateArticle, team(), { slug: article.slug, content: mine, revision: opened })).rejects.toMatchObject({ code: "changed" });
  await call(updateArticle, team(), { slug: article.slug, content: mine, revision: opened, seen: await newest(article.id) });
  expect(await changes(article.id)).toBe("Themes change how the app looks.\nLight\nPick Light in Settings.\nDark\nDark is here.");
});

test("Restore of a version that reverts one of an edit's two sections says so first and dismisses it (an editor save would leave it waiting)", async () => {
  const article = await sectioned();
  const both = await landArticleEdit(project.id, article.id, 90, (doc) => rewrite("Dark", "Dark is here.")(rewrite("Light", "Pick Light or Dark in Settings.")(doc)));
  const saved = async () => docOf(await prisma.articleChanges.findUniqueOrThrow({ where: { articleId: article.id } }));
  // A teammate's save puts Light back: a teammate's edit on top, the edit still waiting.
  await call(updateArticle, team(), { slug: article.slug, content: rewrite("Light", "Pick Light in Settings.")(await saved()), revision: await newest(article.id) });
  const lightBack = await newest(article.id);
  expect(await statusOf(both.id)).toBe("PENDING");
  // Then Light as the edit wrote it again; restoring the version with Light put back reverts one of its sections.
  await call(updateArticle, team(), { slug: article.slug, content: rewrite("Light", "Pick Light or Dark in Settings.")(await saved()), revision: await newest(article.id) });
  await expect(call(restoreArticle, team(), { slug: article.slug, revision: lightBack })).rejects.toMatchObject({ code: "edits_waiting" });
  await call(restoreArticle, team(), { slug: article.slug, revision: lightBack, dismissEdits: [both.id] });
  expect(await statusOf(both.id)).toBe("DISMISSED");
});

test("after a save that merged and renamed, renaming again once another edit landed is the saver's own, not someone else's", async () => {
  const article = await sectioned();
  const opened = await newest(article.id);
  await landArticleEdit(project.id, article.id, 91, rewrite("Dark", "Dark is here."));
  const first = await call(updateArticle, team(), { slug: article.slug, title: "Paying", content: rewrite("Light", "Pick Light.")(START), revision: opened });
  expect(first.merged).toBe(true);
  await landArticleEdit(project.id, article.id, 92, rewrite("", "Themes change everything."));
  await call(updateArticle, team(), { slug: article.slug, title: "Paying by card", content: rewrite("Light", "Pick Light.")(START), revision: opened, own: first.revision! });
  expect((await prisma.articleChanges.findUniqueOrThrow({ where: { articleId: article.id }, select: { title: true } })).title).toBe("Paying by card");
});

test("after a save that saw an edit and wrote its own text over one of its sections, going on typing there isn't blamed on Autopilot", async () => {
  const article = await sectioned();
  const opened = await newest(article.id);
  // PR #93 changes Light and Dark; the teammate's Light is refused, then saved having seen it (Dark kept: merged).
  await landArticleEdit(project.id, article.id, 93, (doc) => rewrite("Dark", "Dark is here.")(rewrite("Light", "Pick Light or Dark in Settings.")(doc)));
  const mine = rewrite("Light", "Pick Light, always.")(START);
  await expect(call(updateArticle, team(), { slug: article.slug, content: mine, revision: opened })).rejects.toMatchObject({ code: "autopilot_changed" });
  const first = await call(updateArticle, team(), { slug: article.slug, content: mine, revision: opened, seen: await newest(article.id) });
  expect(first.merged).toBe(true);
  // PR #94 lands in the opening; the teammate goes on in Light (their own now).
  await landArticleEdit(project.id, article.id, 94, rewrite("", "Themes change everything."));
  await call(updateArticle, team(), { slug: article.slug, content: rewrite("Light", "Pick Light, always, by default.")(START), revision: opened, own: first.revision! });
  expect(await changes(article.id)).toBe("Themes change everything.\nLight\nPick Light, always, by default.\nDark\nDark is here.");
});

test("restoring an edit's own version over a teammate's tweak to it keeps the edit waiting (nothing of it is taken out)", async () => {
  const article = await sectioned();
  const edit = await landArticleEdit(project.id, article.id, 97, rewrite("Light", "Pick Light or Dark in Settings."));
  const editsOwn = await newest(article.id);
  // A teammate tweaks the edit's section (an edit on top), then restores the edit's own version.
  const saved = docOf(await prisma.articleChanges.findUniqueOrThrow({ where: { articleId: article.id } }));
  await call(updateArticle, team(), { slug: article.slug, content: rewrite("Light", "Pick Light or Dark in Preferences.")(saved), revision: editsOwn });
  await call(restoreArticle, team(), { slug: article.slug, revision: editsOwn });
  expect(await statusOf(edit.id)).toBe("PENDING");
  expect(await changes(article.id)).toBe("Themes change how the app looks.\nLight\nPick Light or Dark in Settings.\nDark\nDark is coming.");
});

test("a title is saved only if sent: the editor leaving it alone keeps a teammate's rename since; one it sends is applied, a change back to how it opened too", async () => {
  const article = await sectioned();
  const opened = await newest(article.id);
  await landArticleEdit(project.id, article.id, 98, rewrite("Dark", "Dark is here."));
  await call(updateArticle, team(), { slug: article.slug, title: "Paying by card" });
  // The editor's save, its title untouched (not sent): the rename stays, the text goes in by section.
  const form = new FormData();
  form.set("content", JSON.stringify(rewrite("Light", "Pick Light.")(START)));
  form.set("revision", opened);
  const first = await saveArticle(project.slug, article.slug, {}, form);
  expect(first.error).toBeUndefined();
  const title = async () => (await prisma.articleChanges.findUniqueOrThrow({ where: { articleId: article.id }, select: { title: true } })).title;
  expect(await title()).toBe("Paying by card");
  // Renamed by its user, then changed back to how it opened: both are theirs, and applied.
  const own = first.saved!.revision!;
  await call(updateArticle, team(), { slug: article.slug, title: "Paying", content: rewrite("Light", "Pick Light.")(START), revision: opened, own });
  expect(await title()).toBe("Paying");
  await call(updateArticle, team(), { slug: article.slug, title: "Change the theme", content: rewrite("Light", "Pick Light.")(START), revision: opened, own: await newest(article.id) });
  expect(await title()).toBe("Change the theme");
});

test("publishing goes only through a version the saver saw: a stale save that publishes is refused, title-only or merging; on the newest it publishes", async () => {
  const article = await sectioned();
  const opened = await newest(article.id);
  const edit = await landArticleEdit(project.id, article.id, 99, rewrite("Dark", "Dark is here."));
  await expect(call(updateArticle, team(), { slug: article.slug, title: "New", revision: opened, publish: true })).rejects.toMatchObject({ code: "changed" });
  await expect(
    call(updateArticle, team(), { slug: article.slug, content: rewrite("Light", "Pick Light.")(START), revision: opened, publish: true }),
  ).rejects.toMatchObject({ code: "changed" });
  // Without any version while it waits: refused too.
  await expect(call(updateArticle, team(), { slug: article.slug, title: "New", publish: true })).rejects.toMatchObject({ code: "revision_required" });
  expect(await statusOf(edit.id)).toBe("PENDING");
  // Made on the newest (the edit in front of it): it publishes, approving the edit with it.
  await call(updateArticle, team(), { slug: article.slug, title: "New", revision: await newest(article.id), publish: true });
  expect(await statusOf(edit.id)).toBe("APPLIED");
});

test("an API save of a title as it was at its version keeps a teammate's rename since; a different one is refused", async () => {
  const article = await sectioned();
  const opened = await newest(article.id);
  await call(updateArticle, team(), { slug: article.slug, title: "Paying by card" });
  await call(updateArticle, team(), { slug: article.slug, title: "Change the theme", content: rewrite("Dark", "Dark is here.")(START), revision: opened });
  expect((await prisma.articleChanges.findUniqueOrThrow({ where: { articleId: article.id }, select: { title: true } })).title).toBe("Paying by card");
  await expect(call(updateArticle, team(), { slug: article.slug, title: "Themes", revision: opened })).rejects.toMatchObject({ code: "changed" });
});

test("the merged save's panel names whose change it kept: Autopilot's edit, or someone's save", async () => {
  const article = await sectioned();
  const form = (content: Doc, revision: string, extra: Record<string, string> = {}) => {
    const data = new FormData();
    data.set("content", JSON.stringify(content));
    data.set("revision", revision);
    for (const [key, value] of Object.entries(extra)) {
      data.set(key, value);
    }
    return data;
  };
  // Autopilot's edit since: its wording.
  const opened = await newest(article.id);
  await landArticleEdit(project.id, article.id, 100, rewrite("Dark", "Dark is here."));
  const byAutopilot = await saveArticle(project.slug, article.slug, {}, form(rewrite("Light", "Pick Light.")(START), opened));
  expect(byAutopilot.saved).toMatchObject({ merged: true, version: { byAutopilot: true } });
  // A teammate's save since: refused, then saved having seen it, keeping their part: not Autopilot's.
  const teammate = await signUp("Tom Teammate");
  await prisma.teamMember.create({ data: { projectId: project.id, userId: teammate.id, role: "MEMBER" } });
  const reopened = await newest(article.id);
  const now = docOf(await prisma.articleChanges.findUniqueOrThrow({ where: { articleId: article.id } }));
  await call(updateArticle, { actor: { kind: "user" as const, userId: teammate.id }, projectId: project.id }, { slug: article.slug, content: rewrite("", "Themes, in short.")(now), revision: reopened });
  const mine = rewrite("Light", "Pick Light, always.")(now);
  const refused = await saveArticle(project.slug, article.slug, {}, form(mine, reopened));
  expect(refused.newest).toBeDefined();
  const kept = await saveArticle(project.slug, article.slug, refused, form(mine, reopened, { seen: refused.newest!.revision! }));
  expect(kept.saved).toMatchObject({ merged: true, version: { byAutopilot: false } });
});

