-- The claim a queued analysis carries, so a job a later claim replaced does nothing (docs/plan.md, E6).
-- AlterTable
ALTER TABLE "code_change" ADD COLUMN     "claim" TEXT;
