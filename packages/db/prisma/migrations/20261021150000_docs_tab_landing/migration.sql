-- What a docs tab's path shows: an overview (as before), its first article, or a page the team picks.
CREATE TYPE "DocsLanding" AS ENUM ('OVERVIEW', 'FIRST', 'PAGE');

-- AlterTable
ALTER TABLE "docs_tab" ADD COLUMN "landing" "DocsLanding" NOT NULL DEFAULT 'OVERVIEW',
ADD COLUMN "landingArticleId" TEXT,
ADD COLUMN "landingCollectionId" TEXT;

-- CreateIndex
CREATE INDEX "docs_tab_landingArticleId_idx" ON "docs_tab"("landingArticleId");

-- CreateIndex
CREATE INDEX "docs_tab_landingCollectionId_idx" ON "docs_tab"("landingCollectionId");

-- AddForeignKey
ALTER TABLE "docs_tab" ADD CONSTRAINT "docs_tab_landingArticleId_fkey" FOREIGN KEY ("landingArticleId") REFERENCES "article"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "docs_tab" ADD CONSTRAINT "docs_tab_landingCollectionId_fkey" FOREIGN KEY ("landingCollectionId") REFERENCES "collection"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- A tab shows one picked page at most: an article or a collection.
ALTER TABLE "docs_tab" ADD CONSTRAINT "docs_tab_one_landing_page" CHECK (num_nonnulls("landingArticleId", "landingCollectionId") <= 1);
