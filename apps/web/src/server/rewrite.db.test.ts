import { prisma } from "@tuti/db";
import { type ModelFake, startModelFake } from "@tuti/testkit";
import { afterAll, afterEach, beforeAll, beforeEach, expect, test, vi } from "vitest";

import { AI_EDITS_PER_HOUR, createChangelogEntry, updateChangelogStyle } from "@/server/operations/changelog";
import { call } from "@/server/operations/run";
import { rewriteText } from "@/server/rewrite";
import { actAs, createProject, signUp, type TestUser } from "@/test/helpers";

/** Ask AI in the editors (rewriteText): the text on screen edited as the team asks, against the model fake. */

let model: ModelFake;
let owner: TestUser;
let project: Awaited<ReturnType<typeof createProject>>;

beforeAll(async () => {
  model = await startModelFake();
});
afterAll(() => model.close());
beforeEach(async () => {
  for (const [name, value] of Object.entries(model.env)) {
    vi.stubEnv(name, value);
  }
  owner = await signUp("Owner");
  project = await createProject(owner);
  actAs(owner);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  model.requests.length = 0;
  // Every scripted reply was used, and nothing asked the model unscripted.
  model.done();
});

const team = () => ({ actor: { kind: "user" as const, userId: owner.id }, projectId: project.id });
const reply = (notes: string) => JSON.stringify({ notes });
const text = (value: string, marks?: object[]) => (marks ? { type: "text", text: value, marks } : { type: "text", text: value });
const paragraph = (...content: object[]) => ({ type: "paragraph", content });
const heading = (level: number, value: string) => ({ type: "heading", attrs: { level }, content: [text(value)] });
const link = (value: string, href: string) => text(value, [{ type: "link", attrs: { href } }]);
const doc = (...content: object[]) => ({ type: "doc", content });
const code = { type: "codeBlock", attrs: { language: null, filename: null }, content: [text("tuti export --all")] };
const data = (user: string) => JSON.parse(user.slice(user.indexOf("{"))) as Record<string, unknown>;
const usage = () => prisma.aiUsage.findMany({ where: { projectId: project.id }, select: { feature: true } });

test("an article's selection: edited as asked, what the AI can't write kept as it was, charged as help center edits, nothing saved", async () => {
  const selection = doc(
    paragraph(text("To export, open "), link("Reports", "https://example.com/reports"), text(" and press Export.")),
    paragraph(text("It is "), text("really", [{ type: "italic" }]), text(" quick.")),
    code,
  );
  const whole = doc(heading(2, "Exporting"), ...selection.content, paragraph(text("That's all.")));
  model.reply(reply("{{media 1}}\n\nOpen [Reports](https://example.com/reports), then **Export**.\n\n{{media 2}}"));

  const result = await rewriteText(project.slug, { kind: "article", text: selection, whole, instruction: "Shorter" });

  const [request] = model.requests;
  expect(request!.system).toMatch(/^You edit part of an article in a product's help center/);
  expect(request!.system).toContain("Write like the rest of the article");
  expect(request!.user).toMatch(/^Edit this text as the team's instruction says/);
  // The paragraph with italics and the code go as lines to keep; the whole article goes as context.
  expect(data(request!.user)).toEqual({
    textToEdit: "To export, open [Reports](https://example.com/reports) and press Export.\n\n{{media 1}}\n\n{{media 2}}",
    wholeArticle: expect.stringContaining("## Exporting"),
    teamInstruction: "Shorter",
  });
  // A kept block may move, not swap: here the italics paragraph moved ahead, in order.
  expect(result).toEqual({
    content: doc(
      paragraph(text("It is "), text("really", [{ type: "italic" }]), text(" quick.")),
      paragraph(text("Open "), link("Reports", "https://example.com/reports"), text(", then "), text("Export", [{ type: "bold" }]), text(".")),
      code,
    ),
  });
  expect(await usage()).toEqual([{ feature: "help_center" }]);
});

test("a changelog entry's text: written in the changelog's style, charged as changelog edits", async () => {
  await call(updateChangelogStyle, team(), { tone: "Friendly. Address the reader as you." });
  const entry = await call(createChangelogEntry, team(), { title: "Spring release", body: "Draft" });
  model.reply(reply("You can export reports now."));

  const result = await rewriteText(project.slug, { kind: "changelog", entry: entry.number, text: doc(paragraph(text("Reports can now be exported by users."))), instruction: "Friendlier" });

  const [request] = model.requests;
  expect(request!.system).toMatch(/^You edit part of an entry in a product's changelog/);
  expect(data(request!.user)).toMatchObject({ teamInstruction: "Friendlier", writingStyle: { toneNotes: "Friendly. Address the reader as you." } });
  expect(data(request!.user)).not.toHaveProperty("wholeEntry");
  expect(result).toEqual({ content: doc(paragraph(text("You can export reports now."))) });
  expect(await usage()).toEqual([{ feature: "changelog" }]);
});

test("a version that drops a link, or a block it had to keep, or swaps the kept blocks, isn't offered", async () => {
  const withLink = doc(paragraph(text("See "), link("the guide", "https://example.com/guide"), text(" for more.")));
  model.reply(reply("See the guide."));
  expect(await rewriteText(project.slug, { kind: "article", text: withLink, instruction: "Shorter" })).toEqual({
    error: "The AI's version left out the link to https://example.com/guide, so it wasn't used. Try again.",
  });

  const withCode = doc(paragraph(text("Run this command:")), code, paragraph(text("It is "), text("fast", [{ type: "italic" }])));
  model.reply(reply("Run:\n\n{{media 1}}"));
  expect(await rewriteText(project.slug, { kind: "article", text: withCode, instruction: "Shorter" })).toEqual({
    error: "The AI's version left out a part it had to keep as it is, so it wasn't used. Try again.",
  });
  model.reply(reply("Run:\n\n{{media 2}}\n\n{{media 1}}"));
  expect(await rewriteText(project.slug, { kind: "article", text: withCode, instruction: "Shorter" })).toEqual({
    error: "The AI's version left out a part it had to keep as it is, so it wasn't used. Try again.",
  });
});

test("refused without asking the AI: no instruction, nothing it can edit, another project's entry, someone outside the team", async () => {
  const plain = doc(paragraph(text("Exports are quick.")));
  expect(await rewriteText(project.slug, { kind: "article", text: plain, instruction: "  " })).toEqual({ error: "Say how to change the text" });
  expect(await rewriteText(project.slug, { kind: "article", text: plain, instruction: "x".repeat(201) })).toEqual({
    error: "Keep the instruction under 200 characters",
  });
  expect(await rewriteText(project.slug, { kind: "article", text: doc(code), instruction: "Shorter" })).toEqual({ error: "There's no text the AI can edit there" });
  // Longer than the model's reply could bring back whole: in English, or in fewer characters of Japanese.
  const tooLong = { error: "That's too much text to edit with AI at once: select a shorter part" };
  expect(await rewriteText(project.slug, { kind: "article", text: doc(paragraph(text("Exports are quick. ".repeat(900)))), instruction: "Shorter" })).toEqual(tooLong);
  expect(await rewriteText(project.slug, { kind: "article", text: doc(paragraph(text("書き出しはすぐに終わります。".repeat(300)))), instruction: "Shorter" })).toEqual(tooLong);
  // Not a number the database could look up (a form or a client sending something else).
  expect(await rewriteText(project.slug, { kind: "changelog", entry: 1.5, text: plain, instruction: "Shorter" })).toEqual({ error: "There's no such changelog entry" });
  expect(await rewriteText(project.slug, { kind: "changelog", entry: "2" as unknown as number, text: plain, instruction: "Shorter" })).toEqual({
    error: "There's no such changelog entry",
  });
  expect(await rewriteText(project.slug, { kind: "changelog", entry: 99, text: plain, instruction: "Shorter" })).toEqual({ error: "There's no changelog entry #99" });

  const other = await signUp("Other");
  await createProject(other);
  actAs(other);
  expect(await rewriteText(project.slug, { kind: "article", text: plain, instruction: "Shorter" })).toEqual({ error: "Only the project's team can edit with AI" });
  expect(model.requests).toEqual([]);
  expect(await usage()).toEqual([]);
  // Nothing counted against the hour's AI edits either.
  expect(await prisma.project.findUniqueOrThrow({ where: { id: project.id }, select: { changelogAiCount: true } })).toEqual({ changelogAiCount: 0 });
});

test(`an article's AI edits count against the project's ${AI_EDITS_PER_HOUR} an hour, which the changelog's share`, async () => {
  // Mid-hour, so the test can't straddle two.
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-20T10:30:00Z"));
  await prisma.project.update({ where: { id: project.id }, data: { changelogAiHour: new Date("2026-10-20T10:00:00Z"), changelogAiCount: AI_EDITS_PER_HOUR - 1 } });
  const plain = doc(paragraph(text("Exports are quick.")));
  model.reply(reply("Exports are fast."));
  expect(await rewriteText(project.slug, { kind: "article", text: plain, instruction: "Clearer" })).toEqual({ content: doc(paragraph(text("Exports are fast."))) });
  expect(await prisma.project.findUniqueOrThrow({ where: { id: project.id }, select: { changelogAiCount: true } })).toEqual({ changelogAiCount: AI_EDITS_PER_HOUR });

  expect(await rewriteText(project.slug, { kind: "article", text: plain, instruction: "Clearer" })).toEqual({
    error: `Your team has made ${AI_EDITS_PER_HOUR} AI edits this hour. Try again later.`,
  });
  expect(model.requests).toHaveLength(1);

  // Another project has its own.
  const other = await createProject(owner);
  model.reply(reply("Exports are fast."));
  expect(await rewriteText(other.slug, { kind: "article", text: plain, instruction: "Clearer" })).toEqual({ content: doc(paragraph(text("Exports are fast."))) });
  expect(await prisma.project.findUniqueOrThrow({ where: { id: other.id }, select: { changelogAiCount: true } })).toEqual({ changelogAiCount: 1 });

  // The next hour, the count starts over.
  vi.setSystemTime(new Date("2026-10-20T11:30:00Z"));
  model.reply(reply("Exports are fast."));
  expect(await rewriteText(project.slug, { kind: "article", text: plain, instruction: "Clearer" })).toEqual({ content: doc(paragraph(text("Exports are fast."))) });
  expect(await prisma.project.findUniqueOrThrow({ where: { id: project.id }, select: { changelogAiHour: true, changelogAiCount: true } })).toEqual({
    changelogAiHour: new Date("2026-10-20T11:00:00Z"),
    changelogAiCount: 1,
  });
});

test("a version that drops a line the team still has to fill in isn't offered", async () => {
  const withMarker = doc(paragraph(text("Exports are quick.")), paragraph(text("[Check: does it include archived reports?]")));
  model.reply(reply("Exports are fast."));
  expect(await rewriteText(project.slug, { kind: "article", text: withMarker, instruction: "Shorter" })).toEqual({
    error: "The AI's version left out a line still to fill in, so it wasn't used. Try again.",
  });
});

test("a numbered list stays numbered, from its own first number", async () => {
  const item = (value: string) => ({ type: "listItem", content: [paragraph(text(value))] });
  const steps = doc({ type: "orderedList", attrs: { start: 3 }, content: [item("Open the Reports page"), item("Press the Export button")] });
  model.reply(reply("3. Open Reports\n4. Press Export"));

  const result = await rewriteText(project.slug, { kind: "article", text: steps, instruction: "Shorter" });

  expect(model.requests[0]!.system).toContain('"1. " numbered items');
  expect(data(model.requests[0]!.user)).toMatchObject({ textToEdit: "3. Open the Reports page\n4. Press the Export button" });
  expect(result).toEqual({ content: doc({ type: "orderedList", attrs: { start: 3, type: null }, content: [item("Open Reports"), item("Press Export")] }) });
});

test("a new changelog entry, not saved yet, is edited in the changelog's style too", async () => {
  await call(updateChangelogStyle, team(), { tone: "Friendly. Address the reader as you." });
  model.reply(reply("You can export reports now."));

  const result = await rewriteText(project.slug, { kind: "changelog", text: doc(paragraph(text("Reports can now be exported by users."))), instruction: "Friendlier" });

  expect(data(model.requests[0]!.user)).toMatchObject({ writingStyle: { toneNotes: "Friendly. Address the reader as you." } });
  expect(result).toEqual({ content: doc(paragraph(text("You can export reports now."))) });
});
