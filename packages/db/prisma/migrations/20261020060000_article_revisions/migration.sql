-- Help center: article revisions, deleted articles kept for 30 days (restorable) and the "Updated" date toggle.
-- DropIndex
DROP INDEX "article_projectId_slug_key";

-- AlterTable
ALTER TABLE "article" ADD COLUMN     "deletedAt" TIMESTAMP(3),
ADD COLUMN     "showUpdatedDate" BOOLEAN NOT NULL DEFAULT true;

-- CreateTable
CREATE TABLE "article_revision" (
    "id" TEXT NOT NULL,
    "articleId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL DEFAULT '',
    "content" JSONB,
    "collectionId" TEXT,
    "authorId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "article_revision_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "article_revision_articleId_createdAt_idx" ON "article_revision"("articleId", "createdAt");

-- CreateIndex
CREATE INDEX "article_revision_collectionId_idx" ON "article_revision"("collectionId");

-- CreateIndex
CREATE INDEX "article_revision_authorId_idx" ON "article_revision"("authorId");

-- CreateIndex
CREATE INDEX "article_deletedAt_idx" ON "article"("deletedAt");

-- CreateIndex
CREATE UNIQUE INDEX "article_projectId_slug_key" ON "article"("projectId", "slug") WHERE ("deletedAt" IS NULL);

-- AddForeignKey
ALTER TABLE "article_revision" ADD CONSTRAINT "article_revision_articleId_fkey" FOREIGN KEY ("articleId") REFERENCES "article"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "article_revision" ADD CONSTRAINT "article_revision_collectionId_fkey" FOREIGN KEY ("collectionId") REFERENCES "collection"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "article_revision" ADD CONSTRAINT "article_revision_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- A deleted article is never published, so whatever reads published articles leaves deleted ones out.
ALTER TABLE "article" ADD CONSTRAINT "article_deleted_unpublished" CHECK ("deletedAt" IS NULL OR "publishedAt" IS NULL);

-- Each existing article's current version is its first revision. Publishing bumps updatedAt, so an
-- updatedAt within a second of publishing is the publish itself, not an edit ("Updated" compares the two).
INSERT INTO "article_revision" ("id", "articleId", "title", "body", "content", "collectionId", "authorId", "createdAt")
SELECT gen_random_uuid()::text, a."id", a."title", a."body", a."content", a."collectionId",
  (SELECT u."id" FROM "user" u WHERE u."id" = a."createdById"),
  CASE
    WHEN a."publishedAt" IS NOT NULL AND a."updatedAt" < a."publishedAt" + interval '1 second' THEN a."publishedAt"
    ELSE a."updatedAt"
  END
FROM "article" a;
