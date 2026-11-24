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
import { createProject, signUp, type TestUser, untilWaitingOnLock } from "@/test/helpers";

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
  vi.stubEnv("OPENAI_API_KEY", "");
  const { number } = await entryWithPullRequests();
  await expect(draft(number)).rejects.toMatchObject({ status: 503, message: "AI isn't set up on this server" });
});

test("the model gets what Autopilot wrote about each pull request and the posts it completes, the most voted first", async () => {
  const { number, postUrl } = await entryWithPullRequests();
  const faster = await call(createPost, team(), { board: "feature-requests", title: "Faster search" });
  // Linked to the pull request too, but not for readers: nothing of it reaches the model.
  const secret = await call(createPost, team(), { board: "feature-requests", title: "Tokens logged in plain text", visibility: "team" });
  const entry = await call(updateChangelogEntry, team(), { number, posts: [...(await get(number)).posts.map((post) => post.number), faster.number, secret.number] });
  const url = (post: { number: number }) => entry.posts.find((other) => other.number === post.number)!.url;
  const id = async (post: { number: number }) => (await prisma.post.findUniqueOrThrow({ where: { projectId_number: { projectId: project.id, number: post.number } } })).id;
  const [darkId, fasterId, secretId] = [await id(entry.posts.find((post) => post.url === postUrl)!), await id(faster), await id(secret)];
  await prisma.post.update({ where: { id: darkId }, data: { voteCount: 2 } });
  await prisma.post.update({ where: { id: fasterId }, data: { voteCount: 5 } });
  const pr = (n: number) => ({ projectId: project.id, repo: "acme/app", number: n, url: `https://github.com/acme/app/pull/${n}` });
  // Autopilot analysed #12 and wrote what it changed for users; #13 has no analysis.
  await prisma.codeChange.create({
    data: { ...pr(12), repoId: 1, title: "Add dark theme toggle", author: "dev", mergedAt: new Date(), state: "READY", summary: "You can switch to a dark theme from your profile menu." },
  });
  await prisma.postLink.createMany({
    data: [
      { ...pr(12), postId: darkId, kind: "PULL_REQUEST", source: "CODE_CHANGE" },
      { ...pr(12), postId: secretId, kind: "PULL_REQUEST", source: "MANUAL" },
      { ...pr(13), postId: fasterId, kind: "PULL_REQUEST", source: "MANUAL" },
    ],
  });
  model.reply(reply("Faster search and dark mode", "Search is faster, and there's a dark mode."));

  await draft(number);

  const [request] = model.requests;
  expect(request!.system).toContain("the most voted first");
  const data = JSON.parse(request!.user.slice(request!.user.indexOf("{"))) as Record<string, unknown>;
  expect(data.postsItCompletes).toEqual([
    { title: "Faster search", url: url(faster), votes: 5 },
    { title: "Dark mode", url: postUrl, votes: 2 },
  ]);
  // The one completing the most voted post leads, though it merged later.
  expect(data.pullRequests).toEqual([
    { title: "Speed up post search", ref: "acme/app#13", completes: [url(faster)] },
    { title: "Add dark theme toggle", ref: "acme/app#12", whatChangedForUsers: "You can switch to a dark theme from your profile menu.", completes: [postUrl] },
  ]);
  expect(request!.user).not.toContain("Tokens logged in plain text");
  expect(request!.user).not.toContain(url(secret));
});

test("a draft leaves a line where it needs a fact; the entry isn't published with one left", async () => {
  const { number, postUrl } = await entryWithPullRequests();
  const notes = (...lines: string[]) => reply("Dark mode", lines.join("\n\n"));
  model.reply(notes(`Dark mode is here ([Dark mode](${postUrl})).`, "[Check: is it out on iOS yet?]", "Search is faster."));

  const drafted = await draft(number);

  // Told to ask rather than guess.
  expect(model.requests[0]!.system).toContain('"[Check: the question to answer]"');
  // The line is plain text in the entry, as written.
  expect(drafted.body).toContain("[Check: is it out on iOS yet?]");
  await expect(call(publishChangelogEntry, team(), { number })).rejects.toMatchObject({
    status: 409,
    code: "markers",
    message: "Replace or remove the marker in its text first: [Check: is it out on iOS yet?]",
  });
  expect((await get(number)).status).toBe("draft");

  // Each line left holds publishing back, a "[Screenshot: …]" one (where a picture belongs) too.
  model.reply(notes("Dark mode is here.", "[Screenshot: the [Theme] menu, open]", "- Faster search\n- [Check: which plans?]", "It says [Check: later] in a sentence, which is only text."));
  await draft(number);
  await expect(call(publishChangelogEntry, team(), { number })).rejects.toMatchObject({
    status: 409,
    // One with brackets of its own in it is one all the same; and one the model put inside a sentence, not on a line
    // of its own as asked, would go out to readers just the same.
    message: "Replace or remove the 3 markers in its text first: [Screenshot: the [Theme] menu, open] [Check: which plans?] [Check: later]",
  });
  // In a heading too; two on one line are two; and however it's cased or spaced, it's one.
  await call(updateChangelogEntry, team(), { number, markdown: "## Dark mode [Check: the name]\n\n[Check: iOS?] [Screenshot: the menu]\n\nIt's here [check:when] and [ Screenshot : there ]." });
  await expect(call(publishChangelogEntry, team(), { number })).rejects.toMatchObject({
    status: 409,
    message: "Replace or remove the 5 markers in its text first: [Check: the name] [Check: iOS?] [Screenshot: the menu] [check:when] [ Screenshot : there ]",
  });
  // One the model left open, or with brackets in brackets, is no less a note to self: named to its closing bracket, or to the line's end.
  await call(updateChangelogEntry, team(), { number, body: "Out now [Check: on [the [Pro] plan] too?] and here.\nIt works [Screenshot: the menu" });
  await expect(call(publishChangelogEntry, team(), { number })).rejects.toMatchObject({
    status: 409,
    message: "Replace or remove the 2 markers in its text first: [Check: on [the [Pro] plan] too?] [Screenshot: the menu",
  });
  // In a code block as well.
  await call(updateChangelogEntry, team(), { number, markdown: "Run it:\n\n```\ntuti publish\n[Check: the flag's name]\n```" });
  await expect(call(publishChangelogEntry, team(), { number })).rejects.toMatchObject({ status: 409, message: "Replace or remove the marker in its text first: [Check: the flag's name]" });
  // Replaced (the picture in, the answers written), it's published. Square brackets that aren't a marker are only text.
  await call(updateChangelogEntry, team(), { number, body: "Dark mode is here, on every plan [beta]. Check: it works." });
  expect((await call(publishChangelogEntry, team(), { number })).status).toBe("published");
});

test("once it's published, an entry's text can't gain a marker: a save with one is refused, also one that waited for the publish", async () => {
  const { number } = await call(createChangelogEntry, team(), { title: "Dark mode", body: "Dark mode is here." });
  // A save with a marker, started while the entry is a draft and held up by a publish that's committing.
  let commit!: () => void;
  const held = new Promise<void>((resolve) => (commit = resolve));
  let locked!: () => void;
  const publishing = new Promise<void>((resolve) => (locked = resolve));
  const publish = prisma.$transaction(async (tx) => {
    await tx.changelogEntry.update({ where: { projectId_number: { projectId: project.id, number } }, data: { publishedAt: new Date() } });
    locked();
    await held;
  });
  await publishing;
  const saving = call(updateChangelogEntry, team(), { number, body: "Dark mode is here.\n[Check: is it out on iOS yet?]" });
  saving.catch(() => {});
  await untilWaitingOnLock();
  commit();
  await publish;
  await expect(saving).rejects.toMatchObject({ status: 409, code: "markers", message: "This entry is published. Replace or remove the marker in its text first: [Check: is it out on iOS yet?]" });
  // And any save after it: the text stays as readers have it. Without a marker, a published entry is edited as ever.
  await expect(call(updateChangelogEntry, team(), { number, markdown: "Now with [Screenshot: the menu]." })).rejects.toMatchObject({ status: 409, code: "markers" });
  expect((await get(number)).body).toBe("Dark mode is here.");
  expect((await call(updateChangelogEntry, team(), { number, body: "Dark mode is here, on iOS too." })).body).toBe("Dark mode is here, on iOS too.");
  // One that's there already (published before this, or imported so) doesn't lock the entry: it's edited around, not
  // added to, and taken out.
  await prisma.changelogEntry.update({
    where: { projectId_number: { projectId: project.id, number } },
    data: { body: "Old notes.\n[Check: the date]", content: { type: "doc", content: [paragraph(text("Old notes.")), paragraph(text("[Check: the date]"))] } },
  });
  expect((await call(updateChangelogEntry, team(), { number, body: "Newer notes.\n[Check: the date]" })).body).toBe("Newer notes.\n[Check: the date]");
  await expect(call(updateChangelogEntry, team(), { number, body: "Newer notes.\n[Check: the date]\n[Check: the date]" })).rejects.toMatchObject({ status: 409, code: "markers" });
  expect((await call(updateChangelogEntry, team(), { number, body: "Newer notes, dated." })).body).toBe("Newer notes, dated.");
});

test("publishing reads the text as it is under its lock: a marker saved while it waits holds it back", async () => {
  const { number } = await call(createChangelogEntry, team(), { title: "Dark mode", body: "Dark mode is here." });
  // A save that adds a marker, not committed yet.
  let commit!: () => void;
  const held = new Promise<void>((resolve) => (commit = resolve));
  let saved!: () => void;
  const written = new Promise<void>((resolve) => (saved = resolve));
  const saving = prisma.$transaction(async (tx) => {
    const content = { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "[Check: is it out on iOS yet?]" }] }] };
    await tx.changelogEntry.update({ where: { projectId_number: { projectId: project.id, number } }, data: { body: "[Check: is it out on iOS yet?]", content } });
    saved();
    await held;
  });
  await written;
  // Publishing read the entry before that save; it waits for the entry's row, then goes by what's there.
  const publishing = call(publishChangelogEntry, team(), { number });
  publishing.catch(() => {});
  await untilWaitingOnLock();
  commit();
  await saving;
  await expect(publishing).rejects.toMatchObject({ status: 409, code: "markers" });
  expect((await get(number)).status).toBe("draft");
});

const setStyle = (input: { tone?: string; examples?: number[] }) => call(updateChangelogStyle, team(), input);
const getStyle = () => call(getChangelogStyle, team(), {});

test("the writing style is saved and checked: tone notes up to 4,000 characters, up to 3 of the project's published entries", async () => {
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

  // Room for a page of instructions, and no more.
  expect(await setStyle({ tone: "x".repeat(4000) })).toMatchObject({ tone: "x".repeat(4000) });
  await expect(setStyle({ tone: "x".repeat(4001) })).rejects.toMatchObject({
    status: 400,
    message: "Keep the tone notes under 4,000 characters",
  });
  await setStyle({ tone: "Short sentences." });
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
  expect(await call(getChangelogStyle, { ...team(), projectId: other.id }, {})).toEqual({ tone: "", examples: []  });
  // Refused changes left it as it was.
  expect(await getStyle()).toEqual({ tone: "Short sentences.", examples: [{ number: published.number, title: "Faster search" }]  });

  // An example that's deleted drops out.
  await call(deleteChangelogEntry, team(), { number: published.number });
  expect(await getStyle()).toEqual({ tone: "Short sentences.", examples: []  });
});

test("drafts follow the tone notes and the examples, marked as style only", async () => {
  // Longer than the 2,000 characters examples were once cut to, laid out with a heading and a list, signed off at its end.
  const layout = `## Search\n\n- ${"Search is quicker now. ".repeat(100).trim()}\n- You'll find posts as you type.\n\nThanks for reading, the team`;
  const example = await call(createChangelogEntry, team(), { title: "Faster search", markdown: layout });
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
    // As Markdown and whole: its heading, its list and its last line.
    examplesOfPublishedEntries: [{ title: "Faster search", text: layout }],
  });
});

test("with no examples picked, drafts follow the project's latest published entries: not drafts, samples or the one before those", async () => {
  for (const title of ["Oldest", "Older", "Newer", "Newest"]) {
    const { number } = await call(createChangelogEntry, team(), { title, body: `${title}, written our way.` });
    await call(publishChangelogEntry, team(), { number });
  }
  await call(createChangelogEntry, team(), { title: "Not out yet", body: "A draft." });
  // Home's sample content isn't the team's writing.
  const sample = await call(createChangelogEntry, team(), { title: "Sample update", body: "Lorem ipsum." });
  await call(publishChangelogEntry, team(), { number: sample.number });
  await prisma.changelogEntry.update({ where: { projectId_number: { projectId: project.id, number: sample.number } }, data: { sample: true } });
  const { number } = await entryWithPullRequests();
  model.reply(reply("Dark mode", "You can switch to dark mode now."));

  await draft(number);

  const [request] = model.requests;
  const data = JSON.parse(request!.user.slice(request!.user.indexOf("{"))) as Record<string, unknown>;
  expect(data.writingStyle).toEqual({
    toneNotes: "",
    examplesOfPublishedEntries: ["Newest", "Newer", "Older"].map((title) => ({ title, text: `${title}, written our way.` })),
  });
});

test("the model gets only the entry's public posts: a Team only post's title and link stay out of the text that's published", async () => {
  const { number, postUrl } = await entryWithPullRequests();
  const secret = await call(createPost, team(), { board: "feature-requests", title: "Tokens logged in plain text", visibility: "team" });
  await call(updateChangelogEntry, team(), { number, posts: [...(await get(number)).posts.map((post) => post.number), secret.number] });
  const secretUrl = (await get(number)).posts.find((post) => post.number === secret.number)!.url;
  model.reply(reply("Next release", `Dark mode is here ([Dark mode](${postUrl})), and [tokens](${secretUrl}) are no longer logged.`));

  const entry = await draft(number);

  const [request] = model.requests;
  expect(request!.user).toContain(postUrl);
  expect(request!.user).not.toContain("Tokens logged in plain text");
  expect(request!.user).not.toContain(secretUrl);
  // A link to it the model writes anyway isn't kept.
  expect(JSON.stringify(entry.content)).not.toContain(secretUrl);
});

test("an entry with nothing but posts that aren't public has nothing to draft from: the model isn't asked", async () => {
  const secret = await call(createPost, team(), { board: "feature-requests", title: "Tokens logged in plain text", visibility: "team" });
  const entry = await call(createChangelogEntry, team(), { title: "Security fix", posts: [secret.number] });
  await expect(draft(entry.number)).rejects.toMatchObject({ status: 400, code: "nothing_to_draft", message: "Pick the public posts it completes or write a few notes first" });
});
