import { readFileSync } from "node:fs";

import { prisma } from "@tuti/db";
import { articleChunkText } from "@tuti/shared";
import { FAKE_OPENAI_KEY, type OpenAIFake, startOpenAIFake } from "@tuti/testkit";
import { isValidElement, type ReactElement, type ReactNode } from "react";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";

import { generateMetadata } from "@/app/portal/[project]/(site)/docs/[slug]/page";
import { GET as markdown } from "@/app/portal/[project]/(site)/docs/[slug]/md/route";
import { GET as llms } from "@/app/portal/[project]/(site)/llms.txt/route";
import { GET as sitemap } from "@/app/portal/[project]/(site)/sitemap.xml/route";
import { WidgetDocs } from "@/components/widget-help";
import { actAs, createProject, signUp, type TestUser } from "@/test/helpers";

import { discardArticleChanges, publishArticleChanges, saveArticle } from "./help";
import { docsContents, publishedArticle } from "./help-queries";
import { answerSections, searchDocs } from "./help-search";
import {
  createArticle,
  deleteArticle,
  discardChanges,
  getArticle,
  listArticles,
  listRevisions,
  publishArticle,
  publishChanges,
  restoreArticle,
  unpublishArticle,
  updateArticle,
} from "./operations/help";
import { call } from "./operations/run";

/**
 * Saving a published article keeps its title, text and collection as unpublished changes: every
 * reader keeps the published version until the team publishes them. Sections are embedded through
 * the OpenAI fake, so search by meaning and AI answers' sources are real.
 */

const OLD = { title: "Crossing the road", body: "Use the zebra crossing." };
const NEW = { title: "Crossing the street", body: "Use the quokka bridge." };
const QUESTION = "Where should pedestrians walk?";
const along = (similarity: number) => [similarity, Math.sqrt(1 - similarity ** 2)];

let openai: OpenAIFake;
let owner: TestUser;
let editor: TestUser;
let project: Awaited<ReturnType<typeof createProject>>;

const as = (user: TestUser) => ({ actor: { kind: "user" as const, userId: user.id }, projectId: project.id });
const SLUG = "crossing-the-road";

beforeAll(async () => {
  openai = await startOpenAIFake();
  openai.setVector(QUESTION, along(1));
  for (const version of [OLD, NEW]) {
    openai.setVector(articleChunkText(version.title, { heading: "", text: version.body }), along(0.9));
  }
});
afterAll(() => openai.close());
beforeEach(async () => {
  vi.stubEnv("OPENAI_API_KEY", FAKE_OPENAI_KEY);
  vi.stubEnv("OPENAI_BASE_URL", openai.url);
  owner = await signUp("Olive Owner");
  editor = await signUp("Eddie Editor");
  project = await createProject(owner);
  await prisma.teamMember.create({ data: { projectId: project.id, userId: editor.id, role: "MEMBER" } });
  await prisma.collection.create({ data: { projectId: project.id, slug: "basics", name: "Basics" } });
  await call(createArticle, as(owner), { ...OLD, collection: "basics" });
  await call(publishArticle, as(owner), { slug: SLUG });
  actAs(null);
});
afterEach(() => vi.unstubAllEnvs());

const params = (more: object = {}) => ({ params: Promise.resolve({ project: project.slug, ...more }) });
/** The strings in a server component's output (without rendering the components in it). */
const texts = (node: ReactNode): string[] =>
  Array.isArray(node)
    ? node.flatMap(texts)
    : typeof node === "string"
      ? [node]
      : isValidElement<{ children?: ReactNode }>(node)
        ? texts(node.props.children)
        : [];

/** What each public reader shows of the article: its title and text, or where it's found. */
async function readers() {
  const request = new Request("http://x");
  const article = await publishedArticle(project.slug, SLUG);
  const { collections } = await docsContents(project.slug);
  // The widget's article view (WidgetDocs hands it to WidgetArticle, rendered here).
  const widget = (await WidgetDocs({ projectId: project.id, projectSlug: project.slug, query: "", article: SLUG, hasBoard: true })) as ReactElement<object>;
  const widgetArticle = await (widget.type as (props: object) => Promise<ReactNode>)(widget.props);
  const sections = await answerSections(project.id, QUESTION, 10, [], 3000);
  return {
    page: article && { title: article.title, body: article.body, collection: article.collection?.name, updated: article.updatedAt !== null },
    metadata: (await generateMetadata(params({ slug: SLUG }) as never)).title,
    md: await (await markdown(request, params({ slug: SLUG }) as never)).text(),
    docsContents: collections.map((c) => [c.name, c.articles.map((a) => a.title)]),
    llms: (await (await llms(request, params() as never)).text()).includes(OLD.title),
    sitemap: await (await sitemap(request, params() as never)).text(),
    widget: texts(widgetArticle).includes(OLD.title),
    searchByWords: {
      old: (await searchDocs(project.id, "zebra", 10, [])).map((r) => r.title),
      new: (await searchDocs(project.id, "quokka", 10, [])).map((r) => r.title),
    },
    searchByMeaning: (await searchDocs(project.id, QUESTION, 10, [])).map((r) => r.snippet),
    ai: sections?.map((s) => [s.title, s.text]),
    api: await call(getArticle, as(await signUp()), { slug: SLUG }).then(({ title, body }) => ({ title, body }), () => null),
    apiList: (await call(listArticles, as(await signUp()), {})).articles.map((a) => [a.title, "changes" in a]),
  };
}

async function edit(user = editor, publish?: boolean) {
  return call(updateArticle, as(user), { slug: SLUG, ...NEW, collection: null, ...(publish !== undefined && { publish }) });
}

describe("saving a published article", () => {
  test("keeps the changes unpublished: every reader shows the published version", async () => {
    const published = await readers();
    expect(published).toMatchObject({
      page: { ...OLD, collection: "Basics", updated: false },
      metadata: `${OLD.title} · ${project.name}`,
      md: `# ${OLD.title}\n\n${OLD.body}\n`,
      docsContents: [["Basics", [OLD.title]]],
      llms: true,
      widget: true,
      searchByWords: { old: [OLD.title], new: [] },
      searchByMeaning: [OLD.body],
      ai: [[OLD.title, OLD.body]],
      api: OLD,
      apiList: [[OLD.title, false]],
    });

    const saved = await edit();
    // The team sees both: the published version, and the changes.
    expect(saved).toMatchObject({ ...OLD, status: "published", collection: { slug: "basics" }, changes: { ...NEW, collection: null } });
    expect(await readers()).toEqual(published);
  });

  test("the team sees the changes in articles.get and articles.list; nobody else does", async () => {
    await edit();
    expect(await call(getArticle, as(editor), { slug: SLUG })).toMatchObject({ ...OLD, changes: { ...NEW, savedAt: expect.any(String) } });
    expect((await call(listArticles, as(editor), {})).articles).toMatchObject([{ ...OLD, changes: NEW }]);
    // Another project's team is "nobody else" too.
    const outsider = await signUp();
    await createProject(outsider);
    expect(await call(getArticle, as(outsider), { slug: SLUG })).not.toHaveProperty("changes");
  });

  test("the last save wins, on top of the changes saved before; saving the published version again leaves none", async () => {
    await call(updateArticle, as(editor), { slug: SLUG, title: NEW.title });
    await call(updateArticle, as(owner), { slug: SLUG, body: NEW.body });
    expect((await call(getArticle, as(owner), { slug: SLUG })).changes).toMatchObject({ title: NEW.title, body: NEW.body, collection: { slug: "basics" } });
    await call(updateArticle, as(owner), { slug: SLUG, title: "Crossing safely" });
    expect((await call(getArticle, as(owner), { slug: SLUG })).changes).toMatchObject({ title: "Crossing safely", body: NEW.body });

    await call(updateArticle, as(owner), { slug: SLUG, ...OLD });
    expect((await call(getArticle, as(owner), { slug: SLUG })).changes).toBeNull();
    expect(await prisma.articleChanges.count({ where: { article: { projectId: project.id } } })).toBe(0);
  });

  test("each save is a revision (the newest is the changes), and the slug stays", async () => {
    await edit();
    const { revisions } = await call(listRevisions, as(owner), { slug: SLUG });
    expect(revisions.map((r) => [r.title, r.body, r.author?.name, r.current])).toEqual([
      [NEW.title, NEW.body, "Eddie Editor", true],
      [OLD.title, OLD.body, "Olive Owner", false],
    ]);
    expect((await call(getArticle, as(owner), { slug: SLUG })).slug).toBe(SLUG);
  });

  test("its listing and “Updated” setting change at once", async () => {
    await call(updateArticle, as(owner), { slug: SLUG, body: NEW.body, listing: "hidden", showUpdatedDate: false });
    expect(await publishedArticle(project.slug, SLUG)).toBeNull();
    expect(await call(getArticle, as(owner), { slug: SLUG })).toMatchObject({ listing: "hidden", showUpdatedDate: false, body: OLD.body });
  });
});

describe("publishing and discarding", () => {
  test("“Publish changes” makes them live everywhere, re-embedded, with readers told when it was updated", async () => {
    await edit();
    const published = await call(publishChanges, as(owner), { slug: SLUG });
    expect(published).toMatchObject({ ...NEW, status: "published", slug: SLUG, collection: null, changes: null });
    expect(await readers()).toMatchObject({
      page: { ...NEW, collection: undefined, updated: true },
      md: `# ${NEW.title}\n\n${NEW.body}\n`,
      docsContents: [],
      llms: false,
      widget: false,
      searchByWords: { old: [], new: [NEW.title] },
      searchByMeaning: [NEW.body],
      ai: [[NEW.title, NEW.body]],
      api: NEW,
    });
    // Its revision was recorded by the save: publishing adds none.
    expect((await call(listRevisions, as(owner), { slug: SLUG })).revisions).toHaveLength(2);
    // Nothing left to publish: it does nothing.
    expect(await call(publishChanges, as(owner), { slug: SLUG })).toMatchObject({ ...NEW, changes: null });
  });

  test("“Discard changes” drops them, back to the published version as a new revision", async () => {
    await edit();
    expect(await call(discardChanges, as(owner), { slug: SLUG })).toMatchObject({ ...OLD, changes: null });
    expect(await publishedArticle(project.slug, SLUG)).toMatchObject({ ...OLD, updatedAt: null });
    const { revisions } = await call(listRevisions, as(owner), { slug: SLUG });
    expect(revisions.map((r) => [r.title, r.author?.name])).toEqual([
      [OLD.title, "Olive Owner"],
      [NEW.title, "Eddie Editor"],
      [OLD.title, "Olive Owner"],
    ]);
    // The discarded changes can come back from the history, as unpublished changes again.
    await call(restoreArticle, as(owner), { slug: SLUG, revision: revisions[1]!.id });
    expect(await call(getArticle, as(owner), { slug: SLUG })).toMatchObject({ ...OLD, changes: NEW });
  });

  test("with the `savedAt` they were reviewed at, changes saved again since are neither published nor discarded", async () => {
    const reviewed = (await edit()).changes!.savedAt;
    await call(updateArticle, as(owner), { slug: SLUG, title: "Crossing, unreviewed" });
    for (const operation of [publishChanges, discardChanges]) {
      await expect(call(operation, as(editor), { slug: SLUG, savedAt: reviewed })).rejects.toMatchObject({ status: 409, code: "changed" });
    }
    expect(await call(getArticle, as(owner), { slug: SLUG })).toMatchObject({ ...OLD, changes: { title: "Crossing, unreviewed" } });

    const current = (await call(getArticle, as(owner), { slug: SLUG })).changes!.savedAt;
    expect(await call(publishChanges, as(editor), { slug: SLUG, savedAt: current })).toMatchObject({ title: "Crossing, unreviewed", changes: null });
  });

  test("articles.update with `publish: true` makes the changes live at once, with any saved before", async () => {
    await call(updateArticle, as(editor), { slug: SLUG, body: NEW.body });
    expect(await call(updateArticle, as(owner), { slug: SLUG, title: NEW.title, publish: true })).toMatchObject({ ...NEW, changes: null });
    expect(await readers()).toMatchObject({ page: { ...NEW, updated: true }, searchByMeaning: [NEW.body], ai: [[NEW.title, NEW.body]] });
    // `publish: false` is like leaving it out; on a draft it's ignored (a draft's text is saved as is).
    await call(updateArticle, as(owner), { slug: SLUG, body: OLD.body, publish: false });
    expect(await publishedArticle(project.slug, SLUG)).toMatchObject({ body: NEW.body });
    await call(createArticle, as(owner), { title: "A draft" });
    expect(await call(updateArticle, as(owner), { slug: "a-draft", body: "Text", publish: true })).toMatchObject({ status: "draft", body: "Text" });
  });

  test("restoring a version of a published article keeps it as unpublished changes", async () => {
    await edit(owner, true);
    const [, first] = (await call(listRevisions, as(owner), { slug: SLUG })).revisions;
    expect(await call(restoreArticle, as(owner), { slug: SLUG, revision: first!.id })).toMatchObject({ ...NEW, changes: OLD });
    expect(await publishedArticle(project.slug, SLUG)).toMatchObject(NEW);
  });

  test("the editor's buttons publish and discard them", async () => {
    actAs(editor);
    const savedAt = async () => (await call(getArticle, as(editor), { slug: SLUG })).changes!.savedAt;
    await edit();
    expect(await discardArticleChanges(project.slug, SLUG, await savedAt())).toEqual({});
    expect(await prisma.articleChanges.count({ where: { article: { projectId: project.id } } })).toBe(0);
    await edit();
    expect((await publishArticleChanges(project.slug, SLUG, "2020-01-01T00:00:00.000Z")).error).toMatch(/saved again since/);
    expect(await publishArticleChanges(project.slug, SLUG, await savedAt())).toEqual({});
    expect(await publishedArticle(project.slug, SLUG)).toMatchObject(NEW);

    // Saving the editor's form on a published article keeps the changes too.
    const form = new FormData();
    form.set("title", "From the editor");
    form.set("listing", "everywhere");
    expect(await saveArticle(project.slug, SLUG, {}, form)).toEqual({});
    expect(await publishedArticle(project.slug, SLUG)).toMatchObject({ title: NEW.title });
  });
});

describe("unpublishing, deleting and restoring", () => {
  test("unpublishing makes the changes the draft's text, none of it live", async () => {
    await edit();
    expect(await call(unpublishArticle, as(owner), { slug: SLUG })).toMatchObject({ ...NEW, slug: SLUG, status: "draft", changes: null });
    expect(await readers()).toMatchObject({ page: null, docsContents: [], searchByWords: { old: [], new: [] }, searchByMeaning: [], ai: [] });
    // The history is unchanged: the changes were already its newest version.
    expect((await call(listRevisions, as(owner), { slug: SLUG })).revisions.map((r) => r.title)).toEqual([NEW.title, OLD.title]);
    // Published again, it's that text.
    await call(publishArticle, as(owner), { slug: SLUG });
    expect(await readers()).toMatchObject({ page: { ...NEW, updated: false }, searchByMeaning: [NEW.body] });
  });

  test("deleted, then restored, it's a draft with the changes as its text", async () => {
    await edit();
    await call(deleteArticle, as(owner), { slug: SLUG });
    expect(await prisma.articleChanges.count({ where: { article: { projectId: project.id } } })).toBe(0);
    expect(await call(restoreArticle, as(owner), { slug: SLUG })).toMatchObject({ ...NEW, status: "draft", changes: null });
  });

  test("changes can't be published or discarded on a deleted article, or one of another project", async () => {
    await edit();
    const outsider = await signUp();
    const other = await createProject(outsider);
    const theirs = { actor: { kind: "user" as const, userId: outsider.id }, projectId: other.id };
    await expect(call(publishChanges, theirs, { slug: SLUG })).rejects.toMatchObject({ status: 404 });
    await expect(call(discardChanges, theirs, { slug: SLUG })).rejects.toMatchObject({ status: 404 });
    await call(deleteArticle, as(owner), { slug: SLUG });
    await expect(call(publishChanges, as(owner), { slug: SLUG })).rejects.toMatchObject({ status: 404 });
    await expect(call(discardChanges, as(owner), { slug: SLUG })).rejects.toMatchObject({ status: 404 });
  });
});

describe("the migration", () => {
  test("keeps the “Updated” date of articles edited after they were published", async () => {
    const sql = readFileSync(
      new URL("../../../../packages/db/prisma/migrations/20261020170000_article_changes/migration.sql", import.meta.url),
      "utf8",
    );
    const backfill = sql.slice(sql.indexOf('UPDATE "article"'), sql.lastIndexOf(";") + 1);
    const { id, publishedAt } = await prisma.article.findFirstOrThrow({ where: { projectId: project.id, slug: SLUG } });
    const edited = new Date(publishedAt!.getTime() + 60_000);
    await prisma.articleRevision.create({ data: { articleId: id, ...NEW, createdAt: edited } });
    await prisma.article.update({ where: { id }, data: { revisedAt: null } });

    await prisma.$executeRawUnsafe(backfill);
    expect((await publishedArticle(project.slug, SLUG))!.updatedAt).toEqual(edited);
  });
});
