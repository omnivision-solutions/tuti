-- The block rule a teammate's report added (docs/plan.md, Inbox automation, W2c), so Not spam can offer to remove it.
-- A nullable column: the previous release reads and writes nothing of it.
-- AlterTable
ALTER TABLE "conversation" ADD COLUMN "reportedRuleId" TEXT;
