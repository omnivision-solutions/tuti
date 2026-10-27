-- Support inbox (docs/plan.md, Support inbox, item 3): signed-out visitors' conversations, by a hash of their widget token's id.
-- AlterTable
ALTER TABLE "conversation" ADD COLUMN     "visitorHash" TEXT;

-- CreateIndex
CREATE INDEX "conversation_visitorHash_idx" ON "conversation"("visitorHash");

