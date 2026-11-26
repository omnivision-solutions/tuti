-- Alone in its file: CONCURRENTLY can't run in the transaction Prisma wraps a file of several statements in. Search in
-- Japanese, Korean and Chinese matches inside words by trigrams (pg_trgm, as the Inbox's search; btree_gin for the project).
CREATE INDEX CONCURRENTLY "article_translation_project_body_trgm_idx" ON "article_translation" USING GIN ("projectId", "body" gin_trgm_ops);
