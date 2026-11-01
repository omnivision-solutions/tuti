-- Related articles: one vector per article, the average of its sections' embeddings, so the end of an
-- article ranks one row per article instead of averaging every section on every view. The embedding job
-- (articleChanged) writes it with the sections, once per article.
-- CreateTable
CREATE TABLE "article_vector" (
    "articleId" TEXT NOT NULL,
    "embedding" vector(1536) NOT NULL,

    CONSTRAINT "article_vector_pkey" PRIMARY KEY ("articleId")
);

-- AddForeignKey
ALTER TABLE "article_vector" ADD CONSTRAINT "article_vector_articleId_fkey" FOREIGN KEY ("articleId") REFERENCES "article"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- The articles embedded so far.
INSERT INTO article_vector ("articleId", embedding)
  SELECT "articleId", avg(embedding) FROM article_chunk GROUP BY "articleId";
