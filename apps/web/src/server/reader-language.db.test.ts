import { prisma } from "@tuti/db";
import { billingFile } from "@tuti/testkit";
import { afterEach, expect, test, vi } from "vitest";

import { LANGUAGE_COOKIE } from "@/lib/reader-language";
import { actAs, createProject, signUp } from "@/test/helpers";
import { request } from "@/test/next-headers";

import { currentLanguage } from "./portal-language";
import { chooseLanguage } from "./reader-language";

async function portalIn(...live: string[]) {
  const owner = await signUp();
  const project = await createProject(owner);
  await prisma.projectLanguage.createMany({ data: [...live.map((code) => ({ projectId: project.id, code, live: true })), { projectId: project.id, code: "fr" }] });
  return project;
}

afterEach(() => vi.unstubAllEnvs());

const language = async (userId: string) => (await prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { language: true } })).language;

test("a signed-in reader's choice is kept in the browser and on them, so a browser without the cookie reads in it too", async () => {
  const project = await portalIn("de");
  const reader = await signUp("Reader");
  actAs(reader);
  request.written = [];

  expect(await chooseLanguage(project.slug, "de")).toEqual({});
  expect(request.written).toEqual([{ name: LANGUAGE_COOKIE, value: "de", maxAge: 60 * 60 * 24 * 365 }]);
  expect(await language(reader.id)).toBe("de");
  // Another browser, signed in: their saved language.
  expect((await currentLanguage(project.id, reader.id)).language).toBe("de");
  // This browser's choice comes first.
  request.cookie = `${reader.cookie}; ${LANGUAGE_COOKIE}=en`;
  expect((await currentLanguage(project.id, reader.id)).language).toBe("en");
});

test("only a live language or the default can be chosen; one taken offline falls back to the default", async () => {
  const project = await portalIn("de");
  const reader = await signUp("Reader");
  actAs(reader);

  expect(await chooseLanguage(project.slug, "fr")).toEqual({ error: "This portal isn't in that language" });
  expect(await chooseLanguage(project.slug, "sv")).toEqual({ error: "This portal isn't in that language" });
  expect(await language(reader.id)).toBeNull();

  await chooseLanguage(project.slug, "de");
  await prisma.projectLanguage.update({ where: { projectId_code: { projectId: project.id, code: "de" } }, data: { live: false } });
  expect(await currentLanguage(project.id, reader.id)).toEqual({ languages: { default: "en", live: [] }, language: "en" });
});

test("signed out, the choice is kept in the browser only", async () => {
  const project = await portalIn("de");
  actAs(null);
  request.written = [];
  expect(await chooseLanguage(project.slug, "de")).toEqual({});
  expect(request.written.map(({ name, value }) => [name, value])).toEqual([[LANGUAGE_COOKIE, "de"]]);
  request.cookie = `${LANGUAGE_COOKIE}=de`;
  expect((await currentLanguage(project.id, null)).language).toBe("de");
});

test("past the plan's limit (after a downgrade) only the oldest languages within it are live for readers", async () => {
  const project = await portalIn("de", "es");
  vi.stubEnv("BILLING_CONFIG", billingFile());
  // Pro: up to 3 languages, the default included.
  await prisma.project.update({ where: { id: project.id }, data: { plan: "pro" } });
  await prisma.projectLanguage.update({ where: { projectId_code: { projectId: project.id, code: "fr" } }, data: { live: true } });
  actAs(null);
  request.cookie = `${LANGUAGE_COOKIE}=fr`;
  expect(await currentLanguage(project.id, null)).toEqual({ languages: { default: "en", live: ["de", "es"] }, language: "en" });
  expect(await chooseLanguage(project.slug, "fr")).toEqual({ error: "This portal isn't in that language" });
});

test("a language this release doesn't offer (a newer release's) takes none of the plan's room for readers", async () => {
  const project = await portalIn("de", "es");
  await prisma.projectLanguage.create({ data: { projectId: project.id, code: "sv", live: true, createdAt: new Date(0) } });
  vi.stubEnv("BILLING_CONFIG", billingFile());
  await prisma.project.update({ where: { id: project.id }, data: { plan: "pro" } });
  actAs(null);
  request.cookie = `${LANGUAGE_COOKIE}=es`;
  expect(await currentLanguage(project.id, null)).toEqual({ languages: { default: "en", live: ["de", "es"] }, language: "es" });
  expect(await chooseLanguage(project.slug, "es")).not.toHaveProperty("error");
});
