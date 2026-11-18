import { prisma } from "@tuti/db";
import { beforeEach, expect, test } from "vitest";
import type { z } from "zod";

import { actAs, addMember, createProject, signUp, type TestUser } from "@/test/helpers";

import { saveAssistantSettings } from "../assistant";
import { assistantSettings, getAssistantSettings, offLimitsTopic, updateAssistantSettings } from "./assistant";
import { answerPrompt } from "./docs-ask";
import { call } from "./run";

/** How the docs' AI answers (assistant.*); what reaches the prompt is in docs-ask.db.test.ts. */

let owner: TestUser;
let project: Awaited<ReturnType<typeof createProject>>;

beforeEach(async () => {
  owner = await signUp();
  project = await createProject(owner);
});

const team = (projectId = project.id) => ({ actor: { kind: "user" as const, userId: owner.id }, projectId });
const get = (projectId = project.id) => call(getAssistantSettings, team(projectId), {});
const update = (input: z.input<typeof updateAssistantSettings.input>) => call(updateAssistantSettings, team(), input);
const DEFAULTS = { tone: "", length: "medium", instructions: "", offLimits: [] };

/** What's stored, and a project as the previous release left it: a tone in its own column. */
const stored = () => prisma.project.findUniqueOrThrow({ where: { id: project.id }, select: { assistantTone: true, assistantInstructions: true } });
const storeTone = (assistantTone: string, assistantInstructions: string) => prisma.project.update({ where: { id: project.id }, data: { assistantTone, assistantInstructions } });

test("starts with no tone, instructions or off-limits topics, and medium answers", async () => {
  expect(await get()).toEqual(DEFAULTS);
});

test("the team sets each setting, trimmed; each change leaves the rest, and another project's stay as they were", async () => {
  const other = await createProject(owner);
  expect(await update({ length: "short", instructions: " Call it Acme. ", offLimits: [" refund ", "legal advice", "refund"] })).toEqual({
    tone: "",
    length: "short",
    instructions: "Call it Acme.",
    offLimits: ["refund", "legal advice"],
  });
  expect(await update({ length: "detailed" })).toEqual({ tone: "", length: "detailed", instructions: "Call it Acme.", offLimits: ["refund", "legal advice"] });
  expect(await update({ offLimits: [] })).toMatchObject({ instructions: "Call it Acme.", offLimits: [] });
  expect(await get(other.id)).toEqual(DEFAULTS);
});

test("a stored tone is read folded into the instructions, tone first, without saving; a save writes them and clears it", async () => {
  await storeTone("Cheerful", "Call it Acme.");
  expect(await get()).toMatchObject({ tone: "", instructions: "Cheerful\n\nCall it Acme." });
  // Read twice, and still stored as it was: the previous release goes on reading its tone.
  expect(await get()).toMatchObject({ tone: "", instructions: "Cheerful\n\nCall it Acme." });
  expect(await stored()).toEqual({ assistantTone: "Cheerful", assistantInstructions: "Call it Acme." });
  // A change that isn't to the instructions leaves both.
  await update({ length: "short" });
  expect(await stored()).toEqual({ assistantTone: "Cheerful", assistantInstructions: "Call it Acme." });
  // A tone alone, or instructions alone, reads as it is.
  await storeTone("Cheerful", "");
  expect((await get()).instructions).toBe("Cheerful");
  await storeTone("", "Call it Acme.");
  expect((await get()).instructions).toBe("Call it Acme.");

  // What was read, written straight back, adds nothing, and the tone is stored once: in the instructions.
  await storeTone("Cheerful", "Call it Acme.");
  const read = await get();
  expect(await update(read)).toEqual(read);
  expect(await stored()).toEqual({ assistantTone: "", assistantInstructions: "Cheerful\n\nCall it Acme." });
  expect(await update(await get())).toEqual(read);
  expect(await stored()).toEqual({ assistantTone: "", assistantInstructions: "Cheerful\n\nCall it Acme." });
  // The app's form sends no tone: the instructions as shown, edited.
  await storeTone("Cheerful", "Call it Acme.");
  const form = new FormData();
  form.set("length", "medium");
  // (A browser sends a textarea's line breaks as CRLF; they're stored as the box shows them.)
  form.set("instructions", "Cheerful\r\n\r\nCall it Acme, always.");
  actAs(owner);
  expect(await saveAssistantSettings(project.slug, {}, form)).toEqual({});
  expect(await stored()).toEqual({ assistantTone: "", assistantInstructions: "Cheerful\n\nCall it Acme, always." });
});

test("a tone sent to the API is folded into the instructions saved, and none is stored", async () => {
  // With instructions: before them.
  expect(await update({ tone: " Friendly ", instructions: "Call it Acme." })).toMatchObject({ tone: "", instructions: "Friendly\n\nCall it Acme." });
  expect(await stored()).toEqual({ assistantTone: "", assistantInstructions: "Friendly\n\nCall it Acme." });
  // Alone: before the instructions stored.
  expect(await update({ tone: "Brief" })).toMatchObject({ tone: "", instructions: "Brief\n\nFriendly\n\nCall it Acme." });
  // The same tone sent again doesn't stack, whichever line breaks it's sent with.
  expect(await update({ tone: "Brief\r\n\r\nFriendly" })).toMatchObject({ tone: "", instructions: "Brief\n\nFriendly\n\nCall it Acme." });
  expect(await update({ tone: "Brief" })).toMatchObject({ tone: "", instructions: "Brief\n\nFriendly\n\nCall it Acme." });
  // Nor over instructions stored with CRLF line breaks.
  await storeTone("", "Brief\r\n\r\nCall it Acme.");
  expect(await update({ tone: "Brief" })).toMatchObject({ tone: "", instructions: "Brief\n\nCall it Acme." });
  // Instructions sent with CRLF are saved with LF, and a tone they open with isn't added again.
  expect(await update({ instructions: "a\r\nb" })).toMatchObject({ instructions: "a\nb" });
  expect(await update({ tone: "Brief", instructions: "Brief\r\n\r\nCall it Acme." })).toMatchObject({ instructions: "Brief\n\nCall it Acme." });
  expect(await stored()).toEqual({ assistantTone: "", assistantInstructions: "Brief\n\nCall it Acme." });
  // Alone, where the previous release left a tone: it takes that tone's place, as it did then.
  await storeTone("Cheerful", "Call it Acme.");
  expect(await update({ tone: "Formal" })).toMatchObject({ tone: "", instructions: "Formal\n\nCall it Acme." });
  expect(await stored()).toEqual({ assistantTone: "", assistantInstructions: "Formal\n\nCall it Acme." });
  // An empty one clears a stored tone and adds nothing.
  await storeTone("Cheerful", "Call it Acme.");
  expect(await update({ tone: "" })).toMatchObject({ tone: "", instructions: "Call it Acme." });
  expect(await stored()).toEqual({ assistantTone: "", assistantInstructions: "Call it Acme." });
  // Together they still have to fit.
  await expect(update({ tone: "a".repeat(200), instructions: "b".repeat(2001) })).rejects.toMatchObject({ status: 400, message: "Keep the instructions under 2,202 characters, the tone included" });
  expect(await update({ tone: "a".repeat(200), instructions: "b".repeat(2000) })).toMatchObject({ instructions: `${"a".repeat(200)}\n\n${"b".repeat(2000)}` });
});

test("the answer prompt gets a stored tone and the instructions as one text, the same before and after a save", async () => {
  await storeTone("Cheerful", "Call it Acme.");
  const prompt = async () => answerPrompt("How?", [], await assistantSettings(project.id), []);
  const before = await prompt();
  expect(JSON.parse(before.user.slice(before.user.indexOf("{"))).teamSettings).toEqual({ standingInstructions: "Cheerful\n\nCall it Acme." });
  await update(await get());
  expect(await prompt()).toEqual(before);
});

test("settings are checked: lengths, at most 20 topics with a word in each, a known answer length", async () => {
  const refused = async (input: Parameters<typeof update>[0], message: string) =>
    expect(update(input)).rejects.toMatchObject({ status: 400, message });
  await refused({ tone: "a".repeat(201) }, "Keep the tone under 200 characters");
  await refused({ instructions: "a".repeat(2203) }, "Keep the instructions under 2,202 characters");
  await refused({ offLimits: ["a".repeat(61)] }, "Keep each topic under 60 characters");
  await refused({ offLimits: Array.from({ length: 21 }, (_, i) => `topic ${i}`) }, "Add up to 20 topics");
  await refused({ offLimits: ["?!"] }, "Each topic needs a word in it");
  await refused({ offLimits: [" "] }, "Each topic needs a word in it");
  await refused({ length: "huge" as "short" }, "Pick short, medium or detailed");
  expect(await get()).toEqual(DEFAULTS);
});

test("the app's form takes a field per topic, skipping empty ones; owners and admins only", async () => {
  const form = (...offLimits: string[]) => {
    const data = new FormData();
    data.set("length", "short");
    data.set("instructions", "Call it Acme.");
    for (const topic of offLimits) {
      data.append("offLimits", topic);
    }
    return data;
  };
  actAs(await addMember(project.id, "MEMBER"));
  expect(await saveAssistantSettings(project.slug, {}, form("refund"))).toEqual({ error: "Only project owners and admins can change AI answers" });
  actAs(await signUp("Outsider"));
  expect(await saveAssistantSettings(project.slug, {}, form("refund"))).toEqual({ error: "Only project owners and admins can change AI answers" });
  expect(await get()).toEqual(DEFAULTS);

  actAs(await addMember(project.id, "ADMIN"));
  expect(await saveAssistantSettings(project.slug, {}, form(" refund ", "", " legal advice", " "))).toEqual({});
  expect(await get()).toEqual({ tone: "", length: "short", instructions: "Call it Acme.", offLimits: ["refund", "legal advice"] });
  expect(await saveAssistantSettings(project.slug, {}, form("?!"))).toEqual({ error: "Each topic needs a word in it" });
});

test("off-limits topics match whole words, ignoring case, accents and punctuation", () => {
  const topics = ["refund", "Legal advice", "café"];
  expect(offLimitsTopic("Can I get a REFUND?", topics)).toBe("refund");
  expect(offLimitsTopic("refund", topics)).toBe("refund");
  expect(offLimitsTopic("I need legal-advice, please", topics)).toBe("Legal advice");
  expect(offLimitsTopic("Is the cafe open?", topics)).toBe("café");
  expect(offLimitsTopic("Where's the CAFÉ", topics)).toBe("café");
  // Not inside other words, and not part of a phrase.
  expect(offLimitsTopic("How do refunds work?", topics)).toBeUndefined();
  expect(offLimitsTopic("Is it nonrefundable?", topics)).toBeUndefined();
  expect(offLimitsTopic("Any advice on legal templates?", topics)).toBeUndefined();
  expect(offLimitsTopic("Can I get a refund?", [])).toBeUndefined();
});

test("a tone sent alone while instructions are being saved goes before the new ones, not over them", async () => {
  await storeTone("", "Old.");
  let pending!: ReturnType<typeof update>;
  await prisma.$transaction(async (tx) => {
    // Another save holds the project's row; the tone's update starts meanwhile and has to wait to read.
    await tx.$executeRaw`SELECT 1 FROM project WHERE id = ${project.id} FOR UPDATE`;
    pending = update({ tone: "Brief" });
    // Until it waits on the row: on its locking read, before it has read anything.
    await expect
      .poll(async () => (await prisma.$queryRaw<{ waiting: number }[]>`SELECT count(*)::int AS waiting FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND datname = current_database()`)[0]?.waiting, { timeout: 10_000 })
      .toBe(1);
    await tx.project.update({ where: { id: project.id }, data: { assistantInstructions: "New." } });
  });
  expect(await pending).toMatchObject({ instructions: "Brief\n\nNew." });
});
