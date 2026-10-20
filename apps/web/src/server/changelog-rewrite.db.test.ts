import { prisma } from "@tuti/db";
import { type ModelFake, startModelFake } from "@tuti/testkit";
import { afterAll, afterEach, beforeAll, beforeEach, expect, test, vi } from "vitest";

import { acceptChangelogRewrite, rewriteChangelogEntry } from "@/server/changelog";
import {
  AI_EDITS_PER_HOUR,
  createChangelogEntry,
  getChangelogEntry,
  rewriteChangelogEntry as rewriteOperation,
  updateChangelogEntry,
  updateChangelogStyle,
} from "@/server/operations/changelog";
import { createPost } from "@/server/operations/create";
import { call } from "@/server/operations/run";
import { actAs, createProject, signUp, type TestUser } from "@/test/helpers";

/** The changelog editor's AI helpers (changelog.rewrite, and accepting through changelog.update), against the model fake. */

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
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  model.requests.length = 0;
  // Every scripted reply was used, and nothing asked the model unscripted.
  model.done();
});

const team = () => ({ actor: { kind: "user" as const, userId: owner.id }, projectId: project.id });
const rewrite = (input: { number: number; mode: "shorten" | "plain" | "section"; section?: number | string; instruction?: string }) =>
  call(rewriteOperation, team(), input);
const get = (number: number) => call(getChangelogEntry, team(), { number });
const reply = (notes: string) => JSON.stringify({ notes });

const text = (value: string, marks?: object[]) => (marks ? { type: "text", text: value, marks } : { type: "text", text: value });
const paragraph = (...content: object[]) => ({ type: "paragraph", content });
const heading = (level: number, value: string) => ({ type: "heading", attrs: { level }, content: [text(value)] });
const link = (value: string, href: string) => text(value, [{ type: "link", attrs: { href } }]);
const video = { type: "video", attrs: { provider: "youtube", id: "dQw4w9WgXcQ" } };

/**
 * An entry completing "Dark mode": an intro (section 0), "Dark mode" (1) with a video and a
 * "Details" subsection (2), and "Search" (3).
 */
async function entry() {
  const post = await call(createPost, team(), { board: "feature-requests", title: "Dark mode" });
  const created = await call(createChangelogEntry, team(), { title: "Spring release", body: "Draft", posts: [post.number] });
  const postUrl = created.posts[0]!.url;
  const content = {
    type: "doc",
    content: [
      paragraph(text("We shipped 3 things in v2.4.")),
      heading(2, "Dark mode"),
      paragraph(text("A prefers-color-scheme media query now drives the theme, as asked in "), link("Dark mode", postUrl), text(".")),
      video,
      heading(3, "Details"),
      paragraph(text("Toggle it in settings.")),
      heading(2, "Search"),
      paragraph(text("Search is faster.")),
    ],
  };
  await call(updateChangelogEntry, team(), { number: created.number, content });
  return { number: created.number, postUrl, content };
}

test("shorten: the whole text goes to the model, and its reply becomes a proposed document that isn't saved", async () => {
  const { number, postUrl, content } = await entry();
  const before = await get(number);
  model.reply(
    reply(
      `We shipped 3 things in **v2.4**.\n\n## Dark mode\n\nThe app follows your system's theme ([Dark mode](${postUrl})).\n\n{{media 1}}\n\n## Search\n\n- Faster`,
    ),
  );

  const result = await rewrite({ number, mode: "shorten" });

  const [request] = model.requests;
  expect(request!.system).toContain("Keep every link with its exact url");
  expect(request!.user).toMatch(/^Make this text shorter/);
  const data = JSON.parse(request!.user.slice(request!.user.indexOf("{"))) as Record<string, unknown>;
  // The text as Markdown, the video as a placeholder; the whole text needs no extra context.
  expect(data.textToEdit).toBe(
    `We shipped 3 things in v2.4.\n\n## Dark mode\n\nA prefers-color-scheme media query now drives the theme, as asked in [Dark mode](${postUrl}).\n\n{{media 1}}\n\n### Details\n\nToggle it in settings.\n\n## Search\n\nSearch is faster.`,
  );
  expect(data).not.toHaveProperty("wholeEntry");
  expect(result).toMatchObject({ number, mode: "shorten", section: null, body: before.body });
  expect(result.proposed.content).toEqual({
    type: "doc",
    content: [
      paragraph(text("We shipped 3 things in "), text("v2.4", [{ type: "bold" }]), text(".")),
      heading(2, "Dark mode"),
      paragraph(text("The app follows your system's theme ("), link("Dark mode", postUrl), text(").")),
      video,
      heading(2, "Search"),
      { type: "bulletList", content: [{ type: "listItem", content: [paragraph(text("Faster"))] }] },
    ],
  });
  expect(result.proposed.body).toContain("The app follows your system's theme");
  expect(result.expectedUpdatedAt).toBe((await prisma.changelogEntry.findFirstOrThrow({ where: { projectId: project.id, number } })).updatedAt.toISOString());
  // Nothing saved.
  expect(await get(number)).toEqual(before);
  expect((await get(number)).content).toEqual(content);
});

test("plain: explained for non-developers, following the writing style", async () => {
  await call(updateChangelogStyle, team(), { tone: "Friendly. Address the reader as you." });
  const { number, postUrl } = await entry();
  model.reply(
    reply(
      `We shipped 3 things in v2.4.\n\n## Dark mode\n\nThe app now matches your device's light or dark setting, as asked in [Dark mode](${postUrl}).\n\n{{media 1}}\n\n### Details\n\nTurn it on in settings.\n\n## Search\n\nSearch is faster.`,
    ),
  );

  const result = await rewrite({ number, mode: "plain" });

  const [request] = model.requests;
  expect(request!.user).toMatch(/^Explain this text for people who aren't developers/);
  const data = JSON.parse(request!.user.slice(request!.user.indexOf("{"))) as Record<string, unknown>;
  expect(data.writingStyle).toEqual({ toneNotes: "Friendly. Address the reader as you.", examplesOfPublishedEntries: [] });
  expect(result.proposed.content.content![2]).toEqual(
    paragraph(text("The app now matches your device's light or dark setting, as asked in "), link("Dark mode", postUrl), text(".")),
  );
  expect(result.proposed.body).not.toContain("prefers-color-scheme");
});

test("section: only that section is rewritten, with the team's instruction and the whole entry as context", async () => {
  const { number, content } = await entry();
  model.reply(reply("## Search, faster\n\nResults show up as you type."));

  const result = await rewrite({ number, mode: "section", section: 3, instruction: "  Mention it shows results as you type  " });

  const [request] = model.requests;
  expect(request!.user).toMatch(/^Rewrite this text so it reads better/);
  const data = JSON.parse(request!.user.slice(request!.user.indexOf("{"))) as Record<string, unknown>;
  expect(data.textToEdit).toBe("## Search\n\nSearch is faster.");
  expect(data.wholeEntry).toContain("## Dark mode");
  expect(data.teamInstruction).toBe("Mention it shows results as you type");
  expect(result.section).toEqual({ index: 3, heading: "Search" });
  // The rest stays exactly as it was.
  expect(result.proposed.content).toEqual({
    type: "doc",
    content: [...content.content.slice(0, 6), heading(2, "Search, faster"), paragraph(text("Results show up as you type."))],
  });
});

test("sections: by number or heading; a heading's section runs to the next heading at its level or above", async () => {
  const { number, content, postUrl } = await entry();
  const sectionText = async (section: number | string, notes = "Rewritten.") => {
    model.reply(reply(notes));
    const result = await rewrite({ number, mode: "shorten", section });
    const [request] = model.requests.splice(0);
    return { result, text: (JSON.parse(request!.user.slice(request!.user.indexOf("{"))) as { textToEdit: string }).textToEdit };
  };

  // 0: the text before the first heading.
  const intro = await sectionText(0);
  expect(intro.text).toBe("We shipped 3 things in v2.4.");
  expect(intro.result.section).toEqual({ index: 0, heading: null });
  expect(intro.result.proposed.content.content).toEqual([paragraph(text("Rewritten.")), ...content.content.slice(1)]);
  // An h2 takes its h3 along.
  const dark = await sectionText(1, `[Dark mode](${postUrl}) follows your system.\n\n{{media 1}}`);
  expect(dark.text).toBe(
    `## Dark mode\n\nA prefers-color-scheme media query now drives the theme, as asked in [Dark mode](${postUrl}).\n\n{{media 1}}\n\n### Details\n\nToggle it in settings.`,
  );
  // By its heading, in any case.
  expect((await sectionText(" details ")).text).toBe("### Details\n\nToggle it in settings.");
  expect((await sectionText("SEARCH")).result.section).toEqual({ index: 3, heading: "Search" });

  // No such section, or none picked for "section": the model isn't asked.
  await expect(rewrite({ number, mode: "shorten", section: 4 })).rejects.toMatchObject({ status: 400, message: "There's no section 4" });
  await expect(rewrite({ number, mode: "shorten", section: "Pricing" })).rejects.toMatchObject({
    status: 400,
    message: "There's no section “Pricing”",
  });
  await expect(rewrite({ number, mode: "section" })).rejects.toMatchObject({ status: 400, message: "Pick the section to rewrite" });
  // An entry that starts with a heading has no section 0.
  await call(updateChangelogEntry, team(), { number, content: { type: "doc", content: content.content.slice(1) } });
  await expect(rewrite({ number, mode: "shorten", section: 0 })).rejects.toMatchObject({ status: 400, message: "There's no section 0" });
  expect(model.requests).toEqual([]);
});

test("a version that drops a link to a post, or the video, is refused, and nothing changes", async () => {
  const { number } = await entry();
  const before = await get(number);
  model.reply(reply("## Dark mode\n\nThe theme follows your system.\n\n{{media 1}}\n\n### Details\n\nToggle it in settings."));
  await expect(rewrite({ number, mode: "shorten", section: 1 })).rejects.toMatchObject({
    status: 502,
    code: "dropped_facts",
    message: `The AI's version left out the link to ${before.posts[0]!.url}, so it wasn't used. Try again.`,
  });
  model.reply(reply(`## Dark mode\n\nThe theme follows your system ([Dark mode](${before.posts[0]!.url})). See {{media 1}}.`));
  await expect(rewrite({ number, mode: "shorten", section: 1 })).rejects.toMatchObject({
    status: 502,
    message: "The AI's version left out a video, so it wasn't used. Try again.",
  });
  expect(await get(number)).toEqual(before);
});

test("the reply is untrusted: only links the text had or to the entry's posts survive", async () => {
  const { number, postUrl } = await entry();
  model.reply(
    reply(`<b>Hi</b> [prize](https://evil.example/win) [x](javascript:alert%281%29) [post](${postUrl}) {{media 1}}\n\n{{media 1}}\n\n{{media 1}}\n\n{{media 2}}`),
  );
  const result = await rewrite({ number, mode: "shorten", section: 1 });
  expect(result.proposed.content.content!.slice(1)).toEqual([
    paragraph(text("<b>Hi</b> prize x "), link("post", postUrl), text(" {{media 1}}")),
    // The video once, however often the reply has it; there's no media 2, so that's text.
    video,
    paragraph(text("{{media 2}}")),
    heading(2, "Search"),
    paragraph(text("Search is faster.")),
  ]);
});

/** An entry with only plain text: nothing an edit could drop. */
const plainEntry = async (projectId = project.id) =>
  (await call(createChangelogEntry, { ...team(), projectId }, { title: "Faster search", body: "Search is a lot faster than it was before." })).number;

test("accepting saves it through the normal save, unless the entry changed since (409)", async () => {
  const number = await plainEntry();
  model.reply(reply("Shorter."));
  const first = await rewrite({ number, mode: "shorten" });
  // A save after the proposal: accepting it would write over that.
  await call(updateChangelogEntry, team(), { number, title: "Renamed meanwhile" });
  await expect(
    call(updateChangelogEntry, team(), { number, content: first.proposed.content, expectedUpdatedAt: first.expectedUpdatedAt }),
  ).rejects.toMatchObject({ status: 409, code: "changed" });
  expect(await get(number)).toMatchObject({ title: "Renamed meanwhile", body: first.body });

  // The app's Accept: saved, once.
  actAs(owner);
  model.reply(reply("Shorter."));
  const { rewrite: second } = await rewriteChangelogEntry(project.slug, number, { mode: "shorten" });
  expect(await acceptChangelogRewrite(project.slug, number, second!.proposed.content, second!.expectedUpdatedAt)).toEqual({});
  expect(await get(number)).toMatchObject({ title: "Renamed meanwhile", body: "Shorter.", content: second!.proposed.content });
  expect(await acceptChangelogRewrite(project.slug, number, second!.proposed.content, second!.expectedUpdatedAt)).toEqual({
    error: "The entry changed since. Reload it and try again.",
  });
});

test("only the team, only with AI set up, and the instruction is one line of up to 200 characters", async () => {
  const { number } = await entry();
  actAs(await signUp("Portal user"));
  expect(await rewriteChangelogEntry(project.slug, number, { mode: "shorten" })).toEqual({
    error: "Only the project's team can write the changelog",
  });
  actAs(owner);
  await expect(rewrite({ number, mode: "section", section: 1, instruction: "x".repeat(201) })).rejects.toMatchObject({
    status: 400,
    message: "Keep the instruction under 200 characters",
  });
  expect(await rewriteChangelogEntry(project.slug, number, { mode: "section", section: 1, instruction: "x".repeat(201) })).toEqual({
    error: "Keep the instruction under 200 characters",
  });
  vi.stubEnv("OPENROUTER_API_KEY", "");
  await expect(rewrite({ number, mode: "shorten" })).rejects.toMatchObject({ status: 503, message: "AI isn't set up on this server" });
  expect(model.requests).toEqual([]);
});

test(`a project gets ${AI_EDITS_PER_HOUR} AI edits a clock hour, the whole team together`, async () => {
  // Mid-hour, so the test can't straddle two.
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-20T10:30:00Z"));
  const hour = new Date("2026-10-20T10:00:00Z");
  const number = await plainEntry();
  // A count from an earlier hour starts over.
  await prisma.project.update({ where: { id: project.id }, data: { changelogAiHour: new Date(hour.getTime() - 3_600_000), changelogAiCount: AI_EDITS_PER_HOUR } });
  model.reply(reply("Shorter."));
  await rewrite({ number, mode: "shorten" });
  expect(await prisma.project.findUniqueOrThrow({ where: { id: project.id } })).toMatchObject({ changelogAiHour: hour, changelogAiCount: 1 });

  await prisma.project.update({ where: { id: project.id }, data: { changelogAiCount: AI_EDITS_PER_HOUR - 1 } });
  model.reply(reply("Shorter."));
  await rewrite({ number, mode: "shorten" });
  await expect(rewrite({ number, mode: "shorten" })).rejects.toMatchObject({
    status: 429,
    message: `Your team has made ${AI_EDITS_PER_HOUR} AI edits this hour. Try again later.`,
  });
  // Another project has its own.
  const other = await createProject(owner);
  model.reply(reply("Shorter."));
  await call(rewriteOperation, { ...team(), projectId: other.id }, { number: await plainEntry(other.id), mode: "shorten" });
});
