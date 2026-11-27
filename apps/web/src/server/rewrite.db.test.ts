import { prisma } from "@tuti/db";
import { type ModelFake, startModelFake } from "@tuti/testkit";
import { afterAll, afterEach, beforeAll, beforeEach, expect, test, vi } from "vitest";

import { createChangelogEntry, updateChangelogStyle } from "@/server/operations/changelog";
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
  expect(await rewriteText(project.slug, { kind: "changelog", text: plain, instruction: "Shorter" })).toEqual({ error: "Say which changelog entry it's in" });
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
