import { billingFile } from "@tuti/testkit";
import { afterEach, expect, test, vi } from "vitest";

import { actAs, createProject, signUp } from "@/test/helpers";

import { addLanguage, removeLanguage, setDefaultLanguage, updateLanguage } from "./languages";
import { projectLanguages } from "./operations/languages";

afterEach(() => vi.unstubAllEnvs());

async function setUp() {
  const owner = await signUp();
  const project = await createProject(owner);
  actAs(owner);
  return { slug: project.slug, languages: async () => (await projectLanguages(project.id)).languages };
}

test("Settings → Languages: adding, changing one and removing one leave the others as they were", async () => {
  const { slug, languages } = await setUp();
  expect(await addLanguage(slug, "de")).toEqual({});
  expect(await updateLanguage(slug, "de", { instructions: "Use du.", productAvailable: true })).toEqual({});
  expect(await addLanguage(slug, "fr")).toEqual({});
  expect(await updateLanguage(slug, "fr", { live: true, newPages: "manual" })).toEqual({});
  expect(await languages()).toEqual([
    { code: "de", name: "German", newPages: "automatic", instructions: "Use du.", productAvailable: true, live: false, articles: { translated: 0, waiting: 0, why: null } },
    { code: "fr", name: "French", newPages: "manual", instructions: "", productAvailable: false, live: true, articles: { translated: 0, waiting: 0, why: null } },
  ]);

  expect(await removeLanguage(slug, "de")).toEqual({});
  expect(await languages()).toEqual([{ code: "fr", name: "French", newPages: "manual", instructions: "", productAvailable: false, live: true, articles: { translated: 0, waiting: 0, why: null } }]);
  expect(await updateLanguage(slug, "de", { live: true })).toEqual({ error: "That language was removed" });
  expect(await addLanguage(slug, "fr")).toEqual({ error: "Each language once" });
});

test("two languages added at once are both kept: each add reads and saves the list under the project's lock", async () => {
  const { slug, languages } = await setUp();
  expect(await Promise.all([addLanguage(slug, "de"), addLanguage(slug, "fr"), addLanguage(slug, "es")])).toEqual([{}, {}, {}]);
  expect((await languages()).map(({ code }) => code).sort()).toEqual(["de", "es", "fr"]);
  // A change and a removal at once: neither undoes the other.
  expect(await Promise.all([updateLanguage(slug, "de", { instructions: "Use du." }), removeLanguage(slug, "fr")])).toEqual([{}, {}]);
  expect((await languages()).map(({ code, instructions }) => [code, instructions]).sort()).toEqual([["de", "Use du."], ["es", ""]]);
});

test("the default language changes only while it's the only one; past the plan's limit, adding says why", async () => {
  const { slug, languages } = await setUp();
  expect(await setDefaultLanguage(slug, "de")).toEqual({});
  expect(await addLanguage(slug, "en")).toEqual({});
  expect(await setDefaultLanguage(slug, "fr")).toEqual({ error: expect.stringContaining("Remove the other languages first") });

  vi.stubEnv("BILLING_CONFIG", billingFile());
  expect(await addLanguage(slug, "fr")).toEqual({ error: "Projects on the Free plan have 1 language, the default included. Upgrade to Pro in Settings → Billing to add more." });
  expect((await languages()).map(({ code }) => code)).toEqual(["en"]);
});

test("only owners and admins", async () => {
  const { slug, languages } = await setUp();
  actAs(await signUp());
  expect(await addLanguage(slug, "de")).toEqual({ error: "Only project owners and admins can change the languages" });
  expect(await languages()).toEqual([]);
});
