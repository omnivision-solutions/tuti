-- Related articles: one vector per article, the average of its sections' embeddings, so the end of an
-- article ranks one row per article instead of averaging every section on every view.
-- CreateTable
CREATE TABLE "article_vector" (
    "articleId" TEXT NOT NULL,
    "embedding" vector(1536) NOT NULL,

    CONSTRAINT "article_vector_pkey" PRIMARY KEY ("articleId")
);

-- AddForeignKey
ALTER TABLE "article_vector" ADD CONSTRAINT "article_vector_articleId_fkey" FOREIGN KEY ("articleId") REFERENCES "article"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Kept by the database as article_chunk changes, whichever code changes it (the previous release's too):
-- after each statement, the articles it touched get their average again, or none once they have no sections.
-- Per statement, not per row: an article being deleted has its sections deleted after it, and by then
-- there's nothing to average.
CREATE FUNCTION article_vector_refresh() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO article_vector ("articleId", embedding)
    SELECT c."articleId", avg(c.embedding)
    FROM article_chunk c
    JOIN article a ON a.id = c."articleId"
    WHERE c."articleId" IN (SELECT "articleId" FROM changed)
    GROUP BY c."articleId"
  ON CONFLICT ("articleId") DO UPDATE SET embedding = EXCLUDED.embedding;
  DELETE FROM article_vector v
    WHERE v."articleId" IN (SELECT "articleId" FROM changed)
      AND NOT EXISTS (SELECT 1 FROM article_chunk c WHERE c."articleId" = v."articleId");
  RETURN NULL;
END $$;

CREATE TRIGGER article_chunk_inserted AFTER INSERT ON article_chunk
  REFERENCING NEW TABLE AS changed FOR EACH STATEMENT EXECUTE FUNCTION article_vector_refresh();
CREATE TRIGGER article_chunk_updated AFTER UPDATE ON article_chunk
  REFERENCING NEW TABLE AS changed FOR EACH STATEMENT EXECUTE FUNCTION article_vector_refresh();
CREATE TRIGGER article_chunk_deleted AFTER DELETE ON article_chunk
  REFERENCING OLD TABLE AS changed FOR EACH STATEMENT EXECUTE FUNCTION article_vector_refresh();

-- The articles embedded so far.
INSERT INTO article_vector ("articleId", embedding)
  SELECT "articleId", avg(embedding) FROM article_chunk GROUP BY "articleId";
