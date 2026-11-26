import { prisma } from "@tuti/db";
import { billingFile } from "@tuti/testkit";
import { afterEach, expect, test, vi } from "vitest";
import type { z } from "zod";

import { createProject, signUp } from "@/test/helpers";

import { getLanguages, updateLanguages } from "./languages";
import { call } from "./run";

afterEach(() => vi.unstubAllEnvs());

async function setUp() {
  const owner = await signUp();
  const project = await createProject(owner);
  const context = { actor: { kind: "user" as const, userId: owner.id }, projectId: project.id };
  return {
    project,
    get: () => call(getLanguages, context, {}),
    update: (input: z.input<typeof updateLanguages.input>) => call(updateLanguages, context, input),
  };
}

test("a project starts in English alone; other languages are added offline and automatic, and keep what isn't sent", async () => {
  const { get, update } = await setUp();
  expect(await get()).toEqual({ default: { code: "en", name: "English" }, languages: [], sendVisitors: false });

  await update({ languages: [{ code: "pt-BR", newPages: "manual", productAvailable: true }, { code: "de", instructions: "  Use du.  " }] });
  await update({ languages: [{ code: "de", live: true }, { code: "pt-BR" }] });
  // In the order added.
  expect((await get()).languages).toEqual([
    { code: "pt-BR", name: "Portuguese (Brazil)", newPages: "manual", instructions: "", productAvailable: true, live: false, articles: { translated: 0, waiting: 0, why: null } },
    { code: "de", name: "German", newPages: "automatic", instructions: "Use du.", productAvailable: false, live: true, articles: { translated: 0, waiting: 0, why: null } },
  ]);

  // Left out: removed.
  expect((await update({ languages: [{ code: "pt-BR" }] })).languages.map(({ code }) => code)).toEqual(["pt-BR"]);
});

test("Send visitors to their language is off until it's turned on, and keeps its value when the languages change", async () => {
  const { update } = await setUp();
  expect((await update({ sendVisitors: true })).sendVisitors).toBe(true);
  expect(await update({ languages: [{ code: "de" }] })).toMatchObject({ default: { code: "en" }, sendVisitors: true });
  expect((await update({ languages: [], sendVisitors: false })).sendVisitors).toBe(false);
});

test("only the launch languages, each once, never the default one", async () => {
  const { update } = await setUp();
  await expect(update({ languages: [{ code: "sv" as "de" }] })).rejects.toMatchObject({ status: 400 });
  await expect(update({ languages: [{ code: "de" }, { code: "de" }] })).rejects.toThrow("Each language once");
  await expect(update({ languages: [{ code: "en" }] })).rejects.toThrow("English is the default language");
  await expect(update({})).rejects.toMatchObject({ status: 400 });
  await expect(update({ languages: [{ code: "de", instructions: "a".repeat(2001) }] })).rejects.toThrow("Keep the instructions under 2,000 characters");
  // The limit counts after trimming.
  const saved = await update({ languages: [{ code: "de", instructions: `  ${"a".repeat(2000)}  ` }] });
  expect(saved.languages[0]?.instructions).toHaveLength(2000);
});

test("the default language changes only while it's the only one", async () => {
  const { project, get, update } = await setUp();
  await update({ default: "de" });
  expect((await get()).default).toEqual({ code: "de", name: "German" });

  await update({ languages: [{ code: "en" }] });
  await expect(update({ default: "fr" })).rejects.toThrow("Remove the other languages first");
  await expect(update({ default: "fr", languages: [] })).rejects.toThrow("Remove the other languages first");
  expect(await prisma.project.findUniqueOrThrow({ where: { id: project.id }, select: { language: true } })).toEqual({ language: "de" });

  await update({ languages: [] });
  expect((await update({ default: "fr" })).default.code).toBe("fr");
});

test("the plan limits the languages, the default counted; past it (after a downgrade) none can be added, the rest still change", async () => {
  const { project, get, update } = await setUp();
  // No billing config: no limit.
  await update({ languages: [{ code: "de" }, { code: "fr" }, { code: "es" }] });

  vi.stubEnv("BILLING_CONFIG", billingFile());
  await expect(update({ languages: [{ code: "de" }, { code: "fr" }, { code: "es" }, { code: "it" }] })).rejects.toMatchObject({
    status: 402,
    message: "Projects on the Free plan have 1 language, the default included. Upgrade to Pro in Settings → Billing to add more.",
  });
  // Free has room for the default alone: none of the others goes live.
  await expect(update({ languages: [{ code: "de", live: true }, { code: "fr" }, { code: "es" }] })).rejects.toMatchObject({ status: 402 });
  await update({ languages: [{ code: "de", instructions: "Use du." }, { code: "fr" }, { code: "es" }] });
  await update({ languages: [{ code: "de" }] });
  await expect(update({ languages: [{ code: "de" }, { code: "fr" }] })).rejects.toMatchObject({ status: 402 });

  await prisma.project.update({ where: { id: project.id }, data: { plan: "pro" } });
  await update({ languages: [{ code: "de" }, { code: "fr" }] });
  await expect(update({ languages: [{ code: "de" }, { code: "fr" }, { code: "es" }] })).rejects.toThrow("Projects on the Pro plan have up to 3 languages, the default included. Upgrade to Business");
  expect((await get()).languages.map(({ code }) => code)).toEqual(["de", "fr"]);

  // Over Pro's limit (added without one): the oldest two can go live; the newest, live before, reads as offline and can't go live.
  vi.stubEnv("BILLING_CONFIG", "");
  await update({ languages: [{ code: "de" }, { code: "fr" }, { code: "es", live: true }] });
  vi.stubEnv("BILLING_CONFIG", billingFile());
  expect((await get()).languages.find(({ code }) => code === "es")?.live).toBe(false);
  await update({ languages: [{ code: "de", live: true }, { code: "fr", live: true }, { code: "es" }] });
  expect((await get()).languages.map(({ live }) => live)).toEqual([true, true, false]);
  await expect(update({ languages: [{ code: "de" }, { code: "fr" }, { code: "es", live: true }] })).rejects.toMatchObject({ status: 402 });
  // Back on a plan with room, it's live again.
  vi.stubEnv("BILLING_CONFIG", "");
  expect((await get()).languages.map(({ live }) => live)).toEqual([true, true, true]);
  vi.stubEnv("BILLING_CONFIG", billingFile());
  await update({ languages: [{ code: "de" }, { code: "fr" }, { code: "es", live: false }] });
  // Removing an older one in the same save makes room.
  vi.stubEnv("BILLING_CONFIG", "");
  await update({ languages: [{ code: "de" }, { code: "fr" }, { code: "es" }, { code: "it" }] });
  vi.stubEnv("BILLING_CONFIG", billingFile());
  await update({ languages: [{ code: "fr" }, { code: "es", live: true }, { code: "it" }] });
});

test("languages added in quick saves keep the order they were added in", async () => {
  const { get, update } = await setUp();
  const now = Date.now();
  vi.spyOn(Date, "now").mockReturnValue(now);
  try {
    await update({ languages: [{ code: "de" }, { code: "fr" }, { code: "es" }] });
    // Same millisecond: the first save's languages took now, now + 1 and now + 2.
    await update({ languages: [{ code: "it" }, { code: "de" }, { code: "fr" }, { code: "es" }] });
  } finally {
    vi.restoreAllMocks();
  }
  expect((await get()).languages.map(({ code }) => code)).toEqual(["de", "fr", "es", "it"]);
});

test("a language no longer offered takes none of the plan's room", async () => {
  const { project, get } = await setUp();
  await prisma.projectLanguage.create({ data: { projectId: project.id, code: "xx", createdAt: new Date(0) } });
  await prisma.project.update({ where: { id: project.id }, data: { plan: "pro" } });
  await prisma.projectLanguage.createMany({ data: [{ projectId: project.id, code: "de", live: true, createdAt: new Date(1) }, { projectId: project.id, code: "fr", live: true, createdAt: new Date(2) }] });
  vi.stubEnv("BILLING_CONFIG", billingFile());
  expect((await get()).languages.map(({ code, live }) => [code, live])).toEqual([["de", true], ["fr", true]]);
});

test("a language this release doesn't offer (a newer release's, during a deploy) isn't removed by saving the list without it", async () => {
  const { project, get, update } = await setUp();
  await prisma.projectLanguage.create({ data: { projectId: project.id, code: "sv", instructions: "Du-tilltal." } });
  await update({ languages: [{ code: "de" }] });
  expect((await get()).languages.map(({ code }) => code)).toEqual(["de"]);
  expect(await prisma.projectLanguage.findMany({ where: { projectId: project.id }, select: { code: true, instructions: true }, orderBy: { code: "asc" } })).toEqual([
    { code: "de", instructions: "" },
    { code: "sv", instructions: "Du-tilltal." },
  ]);
});
