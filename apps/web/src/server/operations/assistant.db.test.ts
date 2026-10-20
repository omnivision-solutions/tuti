import { beforeEach, expect, test } from "vitest";
import type { z } from "zod";

import { actAs, addMember, createProject, signUp, type TestUser } from "@/test/helpers";

import { saveAssistantSettings } from "../assistant";
import { getAssistantSettings, offLimitsTopic, updateAssistantSettings } from "./assistant";
import { call } from "./run";

/** How the help center's AI answers (assistant.*); what reaches the prompt is in help-ask.db.test.ts. */

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

test("starts with no tone, instructions or off-limits topics, and medium answers", async () => {
  expect(await get()).toEqual(DEFAULTS);
});

test("the team sets each setting, trimmed; each change leaves the rest, and another project's stay as they were", async () => {
  const other = await createProject(owner);
  expect(
    await update({ tone: "  Friendly ", length: "short", instructions: " Call it Acme. ", offLimits: [" refund ", "legal advice", "refund"] }),
  ).toEqual({ tone: "Friendly", length: "short", instructions: "Call it Acme.", offLimits: ["refund", "legal advice"] });
  expect(await update({ length: "detailed" })).toEqual({ tone: "Friendly", length: "detailed", instructions: "Call it Acme.", offLimits: ["refund", "legal advice"] });
  expect(await update({ tone: "", offLimits: [] })).toMatchObject({ tone: "", offLimits: [] });
  expect(await get(other.id)).toEqual(DEFAULTS);
});

test("settings are checked: lengths, at most 20 topics with a word in each, a known answer length", async () => {
  const refused = async (input: Parameters<typeof update>[0], message: string) =>
    expect(update(input)).rejects.toMatchObject({ status: 400, message });
  await refused({ tone: "a".repeat(201) }, "Keep the tone under 200 characters");
  await refused({ instructions: "a".repeat(2001) }, "Keep the instructions under 2,000 characters");
  await refused({ offLimits: ["a".repeat(61)] }, "Keep each topic under 60 characters");
  await refused({ offLimits: Array.from({ length: 21 }, (_, i) => `topic ${i}`) }, "Add up to 20 topics");
  await refused({ offLimits: ["?!"] }, "Each topic needs a word in it");
  await refused({ offLimits: [" "] }, "Each topic needs a word in it");
  await refused({ length: "huge" as "short" }, "Pick short, medium or detailed");
  expect(await get()).toEqual(DEFAULTS);
});

test("the app's form takes topics one per line, skipping empty ones; owners and admins only", async () => {
  const form = (offLimits: string) => {
    const data = new FormData();
    data.set("tone", "Plain");
    data.set("length", "short");
    data.set("instructions", "Call it Acme.");
    data.set("offLimits", offLimits);
    return data;
  };
  actAs(await addMember(project.id, "MEMBER"));
  expect(await saveAssistantSettings(project.slug, {}, form("refund"))).toEqual({ error: "Only project owners and admins can change AI answers" });
  actAs(await signUp("Outsider"));
  expect(await saveAssistantSettings(project.slug, {}, form("refund"))).toEqual({ error: "Only project owners and admins can change AI answers" });
  expect(await get()).toEqual(DEFAULTS);

  actAs(await addMember(project.id, "ADMIN"));
  expect(await saveAssistantSettings(project.slug, {}, form(" refund \r\n\n legal advice\n"))).toEqual({});
  expect(await get()).toEqual({ tone: "Plain", length: "short", instructions: "Call it Acme.", offLimits: ["refund", "legal advice"] });
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
