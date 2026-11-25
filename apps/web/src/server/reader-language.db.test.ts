import { prisma } from "@tuti/db";
import { expect, test } from "vitest";

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
