-- A published translation's sections, embedded for search in its language (docs/plan.md L7). A new table: nothing the
-- previous release reads changes.
CREATE TABLE "article_translation_chunk" (
    "id" TEXT NOT NULL,
    "translationId" TEXT NOT NULL,
    "articleId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "language" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "heading" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "contentHash" TEXT NOT NULL,
    "embedding" vector(1536) NOT NULL,

    CONSTRAINT "article_translation_chunk_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "article_translation_chunk_projectId_language_idx" ON "article_translation_chunk"("projectId", "language");

CREATE UNIQUE INDEX "article_translation_chunk_translationId_position_key" ON "article_translation_chunk"("translationId", "position");

ALTER TABLE "article_translation_chunk" ADD CONSTRAINT "article_translation_chunk_translationId_fkey" FOREIGN KEY ("translationId") REFERENCES "article_translation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
