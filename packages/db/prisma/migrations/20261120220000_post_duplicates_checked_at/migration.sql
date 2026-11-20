-- When a post was checked for posts it duplicates (docs/plan.md, Duplicates): the embeddings backfill checks the others.
-- AlterTable
ALTER TABLE "post" ADD COLUMN     "duplicatesCheckedAt" TIMESTAMP(3);

-- Posts embedded so far were checked when they were, but an import's: it embeds its posts without checking them (the
-- backfill does).
UPDATE "post" SET "duplicatesCheckedAt" = now()
WHERE "id" IN (SELECT "postId" FROM "post_embedding")
  AND "id" NOT IN (SELECT "localId" FROM "imported_record" WHERE "kind" = 'post');
