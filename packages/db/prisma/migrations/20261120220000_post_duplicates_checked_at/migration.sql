-- When a post was checked for posts it duplicates (docs/plan.md, Duplicates): the embeddings backfill checks the others.
-- AlterTable
ALTER TABLE "post" ADD COLUMN     "duplicatesCheckedAt" TIMESTAMP(3);

-- Posts embedded so far were checked when they were.
UPDATE "post" SET "duplicatesCheckedAt" = now() WHERE "id" IN (SELECT "postId" FROM "post_embedding");
