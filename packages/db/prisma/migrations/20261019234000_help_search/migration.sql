-- Help center search: published articles in sections, with their embeddings (pgvector).
-- CreateTable
CREATE TABLE "article_chunk" (
    "id" TEXT NOT NULL,
    "articleId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "heading" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "contentHash" TEXT NOT NULL,
    "embedding" vector(1536) NOT NULL,

    CONSTRAINT "article_chunk_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "article_chunk_projectId_idx" ON "article_chunk"("projectId");

-- CreateIndex
CREATE UNIQUE INDEX "article_chunk_articleId_position_key" ON "article_chunk"("articleId", "position");

-- AddForeignKey
ALTER TABLE "article_chunk" ADD CONSTRAINT "article_chunk_articleId_fkey" FOREIGN KEY ("articleId") REFERENCES "article"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "article_chunk" ADD CONSTRAINT "article_chunk_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
