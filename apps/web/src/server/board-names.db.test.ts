import { prisma } from "@tuti/db";
import { labelSource } from "@tuti/jobs";
import { beforeEach, expect, test } from "vitest";

import { generateMetadata as boardMetadata } from "@/app/portal/[project]/(site)/feedback/[board]/page";
import { PAGE_LANGUAGE_HEADER } from "@/lib/language-addresses";
import { requestContext } from "@/server/trpc/context";
import { createCaller } from "@/server/trpc/server";
import { createProject, signUp, type TestUser } from "@/test/helpers";
import { request } from "@/test/next-headers";

import { boardNames } from "./portal-labels";
import { updateLanguages } from "./operations/languages";
import { boardsWithCounts } from "./post-lists";
import { SIGNED_OUT_VIEWER } from "./post-visibility";
import { call } from "./operations/run";

/** Readers see boards' names in their language (docs/plan.md, Languages, L14), as L9 does collections'. */

let owner: TestUser;
let project: Awaited<ReturnType<typeof createProject>>;
const as = () => ({ actor: { kind: "user" as const, userId: owner.id }, projectId: project.id });

/** The project's first board, "Feature requests", with a description; German (live) has its translation. */
beforeEach(async () => {
  owner = await signUp("Owner");
  project = await createProject(owner);
  request.headers = {};
  await call(updateLanguages, as(), { languages: [{ code: "de", live: true, newPages: "manual" }, { code: "fr", live: true, newPages: "manual" }] });
  const description = "What we should build.";
  await prisma.board.updateMany({
    where: { projectId: project.id },
    data: {
      description,
      translations: { de: { name: "Funktionswünsche", description: "Was wir bauen sollten.", auto: true, source: labelSource("Feature requests", description) } },
    },
  });
});

/** A page's request at `language`'s address, as proxy.ts sends it on (null: the default language's). */
const at = (language: string | null) =>
  (request.headers = language ? { "x-tuti-language": language, "x-tuti-language-prefix": `/${language}`, "x-tuti-language-default": "en" } : { "x-tuti-language": "en", "x-tuti-language-default": "en" });
const viewer = SIGNED_OUT_VIEWER;

test("at a language's address a board reads in it where it's translated, marked with its lang; elsewhere the team's, marked with theirs", async () => {
  at("de");
  expect((await boardsWithCounts(project.id, viewer)).map(({ name, description, lang }) => ({ name, description, lang }))).toEqual([
    { name: "Funktionswünsche", description: "Was wir bauen sollten.", lang: "de" },
  ]);
  at("fr");
  expect((await boardsWithCounts(project.id, viewer)).map(({ name, description, lang }) => ({ name, description, lang }))).toEqual([
    { name: "Feature requests", description: "What we should build.", lang: "en" },
  ]);
  at(null);
  expect((await boardsWithCounts(project.id, viewer))[0]).toMatchObject({ name: "Feature requests", lang: "en" });
});

test("a translation made from an older name or description isn't shown: the team's is", async () => {
  await prisma.board.updateMany({ where: { projectId: project.id }, data: { name: "Ideas" } });
  at("de");
  const [board] = await boardsWithCounts(project.id, viewer);
  expect(board).toMatchObject({ name: "Ideas", description: "What we should build.", lang: "en" });
});

test("the team's own name there with no description: no description shown beside it, never the team's", async () => {
  await prisma.board.updateMany({ where: { projectId: project.id }, data: { translations: { de: { name: "Wünsche", description: "", auto: false, source: null } } } });
  at("de");
  const named = (await boardNames())({ name: "Feature requests", description: "What we should build.", translations: (await prisma.board.findFirstOrThrow({ where: { projectId: project.id } })).translations });
  expect(named).toMatchObject({ name: "Wünsche", description: null, lang: "de" });
});

test("a board's page title and description are in the page's language where it's translated", async () => {
  const params = { params: Promise.resolve({ project: project.slug, board: "feature-requests" }) } as never;
  at("de");
  expect(await boardMetadata(params)).toMatchObject({ title: "Funktionswünsche", description: "Was wir bauen sollten." });
  at(null);
  expect(await boardMetadata(params)).toMatchObject({ title: "Feature requests", description: "What we should build." });
});

test("similar posts through /api/trpc name their boards in the page's language, which the client says (no proxy headers there)", async () => {
  const board = await prisma.board.findFirstOrThrow({ where: { projectId: project.id } });
  await prisma.post.create({ data: { projectId: project.id, boardId: board.id, authorId: owner.id, number: 1, title: "Dark mode please", status: "PLANNED" } });
  const similar = async (language?: string) => {
    const headers = new Headers({ host: `${project.slug}.localhost:3100`, "sec-fetch-site": "same-origin", ...(language && { [PAGE_LANGUAGE_HEADER]: language }) });
    const { posts } = await createCaller(await requestContext(headers)).posts.similar({ project: project.slug, title: "Dark mode please" });
    return posts.map(({ boardName, boardLang }) => ({ boardName, boardLang }));
  };
  expect(await similar("de")).toEqual([{ boardName: "Funktionswünsche", boardLang: "de" }]);
  expect(await similar()).toEqual([{ boardName: "Feature requests", boardLang: "en" }]);
});
