import { prisma } from "@tuti/db";
import { DEFAULT_AI_MODEL } from "@tuti/shared";
import { type ModelFake, startModelFake } from "@tuti/testkit";
import { afterAll, afterEach, beforeAll, beforeEach, expect, test, vi } from "vitest";

import {
  createChangelogEntry,
  deleteChangelogEntry,
  draftChangelogEntry,
  getChangelogEntry,
  getChangelogStyle,
  publishChangelogEntry,
  unpublishChangelogEntry,
  updateChangelogEntry,
  updateChangelogStyle,
} from "@/server/operations/changelog";
import { createPost } from "@/server/operations/create";
import { call } from "@/server/operations/run";
import { createProject, signUp, type TestUser } from "@/test/helpers";

/** Drafting a changelog entry with AI (changelog.draft), against the model fake. */

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
  vi.unstubAllEnvs();
  model.requests.length = 0;
  // Every scripted reply was used, and nothing asked the model unscripted.
  model.done();
});

const team = () => ({ actor: { kind: "user" as const, userId: owner.id }, projectId: project.id });
const draft = (number: number) => call(draftChangelogEntry, team(), { number });
const get = (number: number) => call(getChangelogEntry, team(), { number });
const reply = (title: string, notes: string) => JSON.stringify({ title, notes });

/** A draft completing "Dark mode", with two merged pull requests (like the running draft). */
async function entryWithPullRequests(title = "Next release") {
  const dark = await call(createPost, team(), { board: "feature-requests", title: "Dark mode" });
  const entry = await call(createChangelogEntry, team(), { title, body: "Add dark theme toggle (acme/app#12)", posts: [dark.number] });
  const { id } = await prisma.changelogEntry.findUniqueOrThrow({
    where: { projectId_number: { projectId: project.id, number: entry.number } },
  });
  await prisma.changelogEntryPullRequest.createMany({
    data: [
      { entryId: id, repo: "acme/app", number: 12, url: "https://github.com/acme/app/pull/12", title: "Add dark theme toggle" },
      { entryId: id, repo: "acme/app", number: 13, url: "https://github.com/acme/app/pull/13", title: "Speed up post search" },
    ],
  });
  return { number: entry.number, postUrl: entry.posts[0]!.url };
}

const text = (value: string) => ({ type: "text", text: value });
const paragraph = (...content: object[]) => ({ type: "paragraph", content });

test("the model gets the pull requests and posts, and its notes become the entry's text and title", async () => {
  const { number, postUrl } = await entryWithPullRequests();
  model.reply(
    "```json\n" +
      reply(
        "Dark mode and faster search",
        `## Dark mode\n\nSwitch to a dark theme from your profile menu, as asked in [Dark mode](${postUrl}).\n\n### Also\n\n- **Faster** search\n- Search finds posts by their text\n\nThanks for the feedback!`,
      ) +
      "\n```",
  );

  const entry = await draft(number);

  const [request] = model.requests;
  expect(request!.model).toBe(DEFAULT_AI_MODEL);
  expect(request!.system).toContain("not how it was built");
  expect(request!.user).toContain('"title": "Dark mode"');
  expect(request!.user).toContain(postUrl);
  expect(request!.user).toContain('"title": "Add dark theme toggle"');
  expect(request!.user).toContain('"ref": "acme/app#13"');
  // No style set: nothing about one.
  expect(request!.user).not.toContain("writingStyle");
  expect(entry.title).toBe("Dark mode and faster search");
  expect(entry.content).toEqual({
    type: "doc",
    content: [
      { type: "heading", attrs: { level: 2 }, content: [text("Dark mode")] },
      paragraph(
        text("Switch to a dark theme from your profile menu, as asked in "),
        { type: "text", text: "Dark mode", marks: [{ type: "link", attrs: { href: postUrl } }] },
        text("."),
      ),
      { type: "heading", attrs: { level: 3 }, content: [text("Also")] },
      {
        type: "bulletList",
        content: [
          { type: "listItem", content: [paragraph({ type: "text", text: "Faster", marks: [{ type: "bold" }] }, text(" search"))] },
          { type: "listItem", content: [paragraph(text("Search finds posts by their text"))] },
        ],
      },
      paragraph(text("Thanks for the feedback!")),
    ],
  });
  expect(entry.body).toContain("Switch to a dark theme");
  // Saved, and the pull requests and posts stay as they were.
  expect(await get(number)).toMatchObject({ title: entry.title, body: entry.body, posts: [{ title: "Dark mode" }] });
  expect((await get(number)).pullRequests).toHaveLength(2);
});

test("a title the team gave stays", async () => {
  const { number } = await entryWithPullRequests("Spring release");
  model.reply(reply("Dark mode", "Dark mode is here."));
  expect(await draft(number)).toMatchObject({ title: "Spring release", body: "Dark mode is here." });
});

test("the reply is untrusted: markup stays text, only links to the entry's posts survive", async () => {
  const { number, postUrl } = await entryWithPullRequests();
  model.reply(
    reply(
      "<img src=x onerror=alert(1)>",
      `<script>alert(1)</script> [click](javascript:alert%281%29) [prize](https://evil.example/win) [post](${postUrl}) [rel](/admin)`,
    ),
  );
  const entry = await draft(number);
  expect(entry.content).toEqual({
    type: "doc",
    content: [
      paragraph(
        text("<script>alert(1)</script> click prize "),
        { type: "text", text: "post", marks: [{ type: "link", attrs: { href: postUrl } }] },
        text(" rel"),
      ),
    ],
  });
  // A title is only text too.
  expect(entry.title).toBe("<img src=x onerror=alert(1)>");
});

test.each([
  ["not JSON", "Here are your release notes: dark mode!"],
  ["JSON without notes", JSON.stringify({ title: "Dark mode" })],
  ["empty notes", reply("Dark mode", "  \n\n- \n## ")],
])("a reply it can't use (%s) changes nothing", async (_, content) => {
  const { number } = await entryWithPullRequests();
  const before = await get(number);
  model.reply(content);
  await expect(draft(number)).rejects.toMatchObject({ status: 502, message: "The AI's draft couldn't be used. Try again." });
  expect(await get(number)).toEqual(before);
});

test("a failing model changes nothing", async () => {
  const { number } = await entryWithPullRequests();
  const before = await get(number);
  model.fail(500);
  await expect(draft(number)).rejects.toMatchObject({ status: 502, message: "The AI couldn't write a draft. Try again in a moment." });
  expect(await get(number)).toEqual(before);
});

test("a save while the model writes wins: the draft isn't written over it", async () => {
  const { number } = await entryWithPullRequests();
  model.reply(reply("Dark mode", "AI notes."), () => call(updateChangelogEntry, team(), { number, body: "Written by hand meanwhile" }));
  await expect(draft(number)).rejects.toMatchObject({ status: 409, code: "changed" });
  expect(await get(number)).toMatchObject({ title: "Next release", body: "Written by hand meanwhile" });
});

test("published entries keep their text, and drafts need something to draft from", async () => {
  const { number } = await entryWithPullRequests();
  await call(publishChangelogEntry, team(), { number });
  await expect(draft(number)).rejects.toMatchObject({ status: 409, message: "Unpublish the entry to draft its text with AI" });

  const empty = await call(createChangelogEntry, team(), { title: "Empty draft" });
  await expect(draft(empty.number)).rejects.toMatchObject({ status: 400, code: "nothing_to_draft" });
  // Neither asked the model.
  expect(model.requests).toEqual([]);
});

test("without an AI key it says AI isn't set up", async () => {
  vi.stubEnv("OPENROUTER_API_KEY", "");
  const { number } = await entryWithPullRequests();
  await expect(draft(number)).rejects.toMatchObject({ status: 503, message: "AI isn't set up on this server" });
});

const setStyle = (input: { tone?: string; examples?: number[] }) => call(updateChangelogStyle, team(), input);
const getStyle = () => call(getChangelogStyle, team(), {});

test("the writing style is saved and checked: tone notes up to 1,000 characters, up to 3 of the project's published entries", async () => {
  expect(await getStyle()).toEqual({ tone: "", examples: [] });
  const published = await call(createChangelogEntry, team(), { title: "Faster search", body: "Search is quicker now." });
  await call(publishChangelogEntry, team(), { number: published.number });
  const draft = await call(createChangelogEntry, team(), { title: "Not out yet" });

  expect(await setStyle({ tone: "  Friendly, no jargon.  ", examples: [published.number] })).toEqual({
    tone: "Friendly, no jargon.",
    examples: [{ number: published.number, title: "Faster search" }],
  });
  // Each field is optional: changing one keeps the other.
  expect(await setStyle({ tone: "Short sentences." })).toMatchObject({ examples: [{ number: published.number }] });

  await expect(setStyle({ tone: "x".repeat(1001) })).rejects.toMatchObject({
    status: 400,
    message: "Keep the tone notes under 1,000 characters",
  });
  await expect(setStyle({ examples: [draft.number] })).rejects.toMatchObject({
    status: 400,
    message: `There's no published entry #${draft.number}`,
  });
  await expect(setStyle({ examples: [1, 2, 3, 4] })).rejects.toMatchObject({ status: 400, message: "Pick up to 3 examples" });
  // Another project's published entry isn't this project's.
  const other = await createProject(owner);
  const theirs = { ...team(), projectId: other.id };
  for (const title of ["First", "Second", "Third"]) {
    await call(createChangelogEntry, theirs, { title });
  }
  await call(publishChangelogEntry, theirs, { number: 3 });
  await expect(setStyle({ examples: [3] })).rejects.toMatchObject({ status: 400, message: "There's no published entry #3" });
  expect(await call(getChangelogStyle, { ...team(), projectId: other.id }, {})).toEqual({ tone: "", examples: [] });
  // Refused changes left it as it was.
  expect(await getStyle()).toEqual({ tone: "Short sentences.", examples: [{ number: published.number, title: "Faster search" }] });

  // An example that's deleted drops out.
  await call(deleteChangelogEntry, team(), { number: published.number });
  expect(await getStyle()).toEqual({ tone: "Short sentences.", examples: [] });
});

test("drafts follow the tone notes and the examples, marked as style only", async () => {
  const example = await call(createChangelogEntry, team(), {
    title: "Faster search",
    body: "Search is quicker now. You'll find posts as you type.",
  });
  await call(publishChangelogEntry, team(), { number: example.number });
  const unpublished = await call(createChangelogEntry, team(), { title: "Old favourite", body: "Written our way." });
  await call(publishChangelogEntry, team(), { number: unpublished.number });
  await setStyle({ tone: "Friendly, short sentences. Address the reader as you.", examples: [example.number, unpublished.number] });
  // Taken off the portal later: no longer an example.
  await call(unpublishChangelogEntry, team(), { number: unpublished.number });
  const { number } = await entryWithPullRequests();
  model.reply(reply("Dark mode", "You can switch to dark mode now."));

  await draft(number);

  const [request] = model.requests;
  expect(request!.system).toContain("never from the examples");
  const data = JSON.parse(request!.user.slice(request!.user.indexOf("{"))) as Record<string, unknown>;
  expect(data.writingStyle).toEqual({
    toneNotes: "Friendly, short sentences. Address the reader as you.",
    examplesOfPublishedEntries: [{ title: "Faster search", text: "Search is quicker now. You'll find posts as you type." }],
  });
});
