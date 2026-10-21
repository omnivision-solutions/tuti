-- "Who can read" on tabs, collections and articles: inherit (the default), signed-in readers, or
-- groups. Collections that have groups today become "groups" (their collection_group rows stay), so
-- who reads what stays the same.

-- CreateEnum
CREATE TYPE "ReadAccess" AS ENUM ('INHERIT', 'SIGNED_IN', 'GROUPS');

-- AlterTable
ALTER TABLE "collection" ADD COLUMN     "access" "ReadAccess" NOT NULL DEFAULT 'INHERIT';

-- AlterTable
ALTER TABLE "docs_tab" ADD COLUMN     "access" "ReadAccess" NOT NULL DEFAULT 'INHERIT';

-- AlterTable
ALTER TABLE "article" ADD COLUMN     "access" "ReadAccess" NOT NULL DEFAULT 'INHERIT';

-- CreateTable
CREATE TABLE "tab_group" (
    "tabId" TEXT NOT NULL,
    "groupId" TEXT NOT NULL,

    CONSTRAINT "tab_group_pkey" PRIMARY KEY ("tabId","groupId")
);

-- CreateTable
CREATE TABLE "article_group" (
    "articleId" TEXT NOT NULL,
    "groupId" TEXT NOT NULL,

    CONSTRAINT "article_group_pkey" PRIMARY KEY ("articleId","groupId")
);

-- CreateIndex
CREATE INDEX "tab_group_groupId_idx" ON "tab_group"("groupId");

-- CreateIndex
CREATE INDEX "article_group_groupId_idx" ON "article_group"("groupId");

-- AddForeignKey
ALTER TABLE "tab_group" ADD CONSTRAINT "tab_group_tabId_fkey" FOREIGN KEY ("tabId") REFERENCES "docs_tab"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tab_group" ADD CONSTRAINT "tab_group_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "reader_group"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "article_group" ADD CONSTRAINT "article_group_articleId_fkey" FOREIGN KEY ("articleId") REFERENCES "article"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "article_group" ADD CONSTRAINT "article_group_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "reader_group"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- Collections for some groups today: "groups", with the same ones.
UPDATE "collection" c SET "access" = 'GROUPS'
WHERE EXISTS (SELECT 1 FROM "collection_group" cg WHERE cg."collectionId" = c."id");
