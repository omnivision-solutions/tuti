-- Article IDs (docs/plan.md L0): `a_` and 8 lowercase letters and digits, made by the database, so existing
-- articles get one here (the default runs per row) and the previous release's inserts get one too.
CREATE FUNCTION "article_public_id"() RETURNS text LANGUAGE sql VOLATILE AS $$
  SELECT 'a_' || string_agg(substr('abcdefghijklmnopqrstuvwxyz0123456789', floor(random() * 36)::int + 1, 1), '')
  FROM generate_series(1, 8)
$$;

ALTER TABLE "article" ADD COLUMN "publicId" TEXT NOT NULL DEFAULT article_public_id();

CREATE UNIQUE INDEX "article_projectId_publicId_key" ON "article"("projectId", "publicId");
