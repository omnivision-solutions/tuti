-- "Similar posts" suggestions use trigram matching on titles.
-- pg_trgm is a trusted extension, so the database owner can enable it.
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- CreateIndex
CREATE INDEX "post_title_trgm_idx" ON "post" USING GIN ("title" gin_trgm_ops);
