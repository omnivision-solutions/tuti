-- Unpublished changes to published articles, and when changes last went live (the portal's "Updated" date).
-- CreateTable
CREATE TABLE "article_changes" (
    "articleId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL DEFAULT '',
    "content" JSONB,
    "collectionId" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "article_changes_pkey" PRIMARY KEY ("articleId")
);

-- CreateIndex
CREATE INDEX "article_changes_collectionId_idx" ON "article_changes"("collectionId");

-- AddForeignKey
ALTER TABLE "article_changes" ADD CONSTRAINT "article_changes_articleId_fkey" FOREIGN KEY ("articleId") REFERENCES "article"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "article_changes" ADD CONSTRAINT "article_changes_collectionId_fkey" FOREIGN KEY ("collectionId") REFERENCES "collection"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AlterTable
ALTER TABLE "article" ADD COLUMN     "revisedAt" TIMESTAMP(3);

-- Until now every save of a published article went live, so its newest revision is when it last changed.
UPDATE "article" a SET "revisedAt" = r."createdAt"
FROM (SELECT "articleId", max("createdAt") AS "createdAt" FROM "article_revision" GROUP BY "articleId") r
WHERE r."articleId" = a.id;
