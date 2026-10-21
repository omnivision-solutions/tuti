import { readFileSync } from "node:fs";

import { prisma } from "@tuti/db";
import { beforeEach, expect, test } from "vitest";

import { createProject, signUp, type TestUser } from "@/test/helpers";

/**
 * "Who can read" on tabs, collections and articles (lib/reader-groups.ts): inherit, signed-in
 * readers or groups, every level from the tab down to the page together.
 */

let owner: TestUser;
let project: Awaited<ReturnType<typeof createProject>>;

beforeEach(async () => {
  owner = await signUp("Owner");
  project = await createProject(owner);
});

test("the migration makes collections with groups “groups”, keeping them, and everything else inherit", async () => {
  const sql = readFileSync(new URL("../../../../packages/db/prisma/migrations/20261021150000_read_access/migration.sql", import.meta.url), "utf8");
  // Back to before it (this file's database is its own).
  await prisma.$executeRawUnsafe(`
    DROP TABLE "tab_group";
    DROP TABLE "article_group";
    ALTER TABLE "docs_tab" DROP COLUMN "access";
    ALTER TABLE "collection" DROP COLUMN "access";
    ALTER TABLE "article" DROP COLUMN "access";
    DROP TYPE "ReadAccess";`);
  await prisma.$executeRaw`INSERT INTO docs_tab (id, "projectId", slug, name, "updatedAt") VALUES ('t1', ${project.id}, 'guides', 'Guides', now())`;
  await prisma.$executeRaw`INSERT INTO reader_group (id, "projectId", key, name, claim, "updatedAt") VALUES ('g1', ${project.id}, 'enterprise', 'Enterprise', 'enterprise', now())`;
  await prisma.$executeRaw`INSERT INTO collection (id, "projectId", "tabId", slug, name, "updatedAt") VALUES ('c1', ${project.id}, 't1', 'basics', 'Basics', now()), ('c2', ${project.id}, 't1', 'saml', 'SAML', now())`;
  await prisma.$executeRaw`INSERT INTO collection_group ("collectionId", "groupId") VALUES ('c2', 'g1')`;
  await prisma.$executeRaw`INSERT INTO article (id, "projectId", "collectionId", slug, title, "updatedAt") VALUES ('a1', ${project.id}, 'c2', 'setup', 'Setup', now())`;

  await prisma.$executeRawUnsafe(sql);

  const levels = { select: { access: true, groups: { select: { group: { select: { key: true } } } } } } as const;
  expect(await prisma.collection.findMany({ where: { projectId: project.id }, orderBy: { slug: "asc" }, select: { slug: true, ...levels.select } })).toEqual([
    { slug: "basics", access: "INHERIT", groups: [] },
    { slug: "saml", access: "GROUPS", groups: [{ group: { key: "enterprise" } }] },
  ]);
  expect(await prisma.docsTab.findMany({ where: { projectId: project.id }, select: levels.select })).toEqual([{ access: "INHERIT", groups: [] }]);
  expect(await prisma.article.findMany({ where: { projectId: project.id }, select: levels.select })).toEqual([{ access: "INHERIT", groups: [] }]);
});
