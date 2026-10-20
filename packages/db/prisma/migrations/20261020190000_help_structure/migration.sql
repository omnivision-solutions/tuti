-- Nested collections (at most 2 levels) and articles' order in their collection.
-- AlterTable
ALTER TABLE "article" ADD COLUMN     "order" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "collection" ADD COLUMN     "parentId" TEXT;

-- CreateIndex
CREATE INDEX "collection_parentId_idx" ON "collection"("parentId");

-- AddForeignKey
ALTER TABLE "collection" ADD CONSTRAINT "collection_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "collection"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Articles were listed by title: that order becomes their numbers, per collection.
UPDATE "article" a SET "order" = n."order"
FROM (
  SELECT id, (row_number() OVER (PARTITION BY "projectId", "collectionId" ORDER BY title, slug) - 1)::int AS "order"
  FROM "article"
) n
WHERE n.id = a.id;
