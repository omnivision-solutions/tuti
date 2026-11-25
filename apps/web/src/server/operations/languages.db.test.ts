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
  expect(await get()).toEqual({ default: { code: "en", name: "English" }, languages: [] });

  await update({ languages: [{ code: "de", instructions: "  Use du.  " }, { code: "pt-BR", newPages: "manual", productAvailable: true }] });
  await update({ languages: [{ code: "de", live: true }, { code: "pt-BR" }] });
  expect((await get()).languages).toEqual([
    { code: "de", name: "German", newPages: "automatic", instructions: "Use du.", productAvailable: false, live: true },
    { code: "pt-BR", name: "Portuguese (Brazil)", newPages: "manual", instructions: "", productAvailable: true, live: false },
  ]);

  // Left out: removed.
  expect((await update({ languages: [{ code: "pt-BR" }] })).languages.map(({ code }) => code)).toEqual(["pt-BR"]);
});

test("only the launch languages, each once, never the default one", async () => {
  const { update } = await setUp();
  await expect(update({ languages: [{ code: "sv" as "de" }] })).rejects.toMatchObject({ status: 400 });
  await expect(update({ languages: [{ code: "de" }, { code: "de" }] })).rejects.toThrow("Each language once");
  await expect(update({ languages: [{ code: "en" }] })).rejects.toThrow("English is the default language");
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
  await update({ languages: [{ code: "de", live: true }, { code: "fr" }, { code: "es" }] });
  await update({ languages: [{ code: "de" }] });
  await expect(update({ languages: [{ code: "de" }, { code: "fr" }] })).rejects.toMatchObject({ status: 402 });

  await prisma.project.update({ where: { id: project.id }, data: { plan: "pro" } });
  await update({ languages: [{ code: "de" }, { code: "fr" }] });
  await expect(update({ languages: [{ code: "de" }, { code: "fr" }, { code: "es" }] })).rejects.toThrow("Projects on the Pro plan have up to 3 languages, the default included. Upgrade to Business");
  expect((await get()).languages.map(({ code }) => code)).toEqual(["de", "fr"]);
});
