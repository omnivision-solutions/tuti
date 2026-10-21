-- CreateTable
CREATE TABLE "docs_redirect" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "tabId" TEXT,
    "collectionId" TEXT,
    "articleId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "docs_redirect_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "docs_redirect_tabId_idx" ON "docs_redirect"("tabId");

-- CreateIndex
CREATE INDEX "docs_redirect_collectionId_idx" ON "docs_redirect"("collectionId");

-- CreateIndex
CREATE INDEX "docs_redirect_articleId_idx" ON "docs_redirect"("articleId");

-- CreateIndex
CREATE UNIQUE INDEX "docs_redirect_projectId_slug_key" ON "docs_redirect"("projectId", "slug");

-- AddForeignKey
ALTER TABLE "docs_redirect" ADD CONSTRAINT "docs_redirect_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "docs_redirect" ADD CONSTRAINT "docs_redirect_tabId_fkey" FOREIGN KEY ("tabId") REFERENCES "docs_tab"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "docs_redirect" ADD CONSTRAINT "docs_redirect_collectionId_fkey" FOREIGN KEY ("collectionId") REFERENCES "collection"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "docs_redirect" ADD CONSTRAINT "docs_redirect_articleId_fkey" FOREIGN KEY ("articleId") REFERENCES "article"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- A redirect points at exactly one page: a tab, a collection or an article.
ALTER TABLE "docs_redirect" ADD CONSTRAINT "docs_redirect_one_page" CHECK (num_nonnulls("tabId", "collectionId", "articleId") = 1);
