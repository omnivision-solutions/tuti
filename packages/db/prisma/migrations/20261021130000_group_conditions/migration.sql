-- Groups from conditions: the SSO token's `attributes` are kept on the identity, and a group can
-- match them (`conditions`) instead of, or as well as, a claim, so the claim becomes optional. Each
-- group gets a `key` for the API and collections; today's groups get their claim.

-- AlterTable
ALTER TABLE "sso_identity" ADD COLUMN "attributes" JSONB NOT NULL DEFAULT '{}';

-- AlterTable
ALTER TABLE "reader_group" ADD COLUMN "key" TEXT,
ADD COLUMN "conditions" JSONB NOT NULL DEFAULT '[]',
ALTER COLUMN "claim" DROP NOT NULL;

UPDATE "reader_group" SET "key" = "claim";

ALTER TABLE "reader_group" ALTER COLUMN "key" SET NOT NULL;

-- CreateIndex
CREATE UNIQUE INDEX "reader_group_projectId_key_key" ON "reader_group"("projectId", "key");
