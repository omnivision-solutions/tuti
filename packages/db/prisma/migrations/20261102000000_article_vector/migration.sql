-- Related articles: one vector per article, the average of its sections' embeddings, so the end of an
-- article ranks one row per article instead of averaging every section on every view. The embedding job
-- (articleChanged) writes it with the sections, once per article; fillArticleVectors mends any that don't
-- match their sections, as the worker starts.
-- CreateTable
CREATE TABLE "article_vector" (
    "articleId" TEXT NOT NULL,
    "contentHash" TEXT NOT NULL,
    "embedding" vector(1536) NOT NULL,

    CONSTRAINT "article_vector_pkey" PRIMARY KEY ("articleId")
);

-- AddForeignKey
ALTER TABLE "article_vector" ADD CONSTRAINT "article_vector_articleId_fkey" FOREIGN KEY ("articleId") REFERENCES "article"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- The articles embedded so far.
INSERT INTO article_vector ("articleId", "contentHash", embedding)
  SELECT "articleId", min("contentHash"), avg(embedding) FROM article_chunk GROUP BY "articleId";
