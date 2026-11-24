-- An import waits for its source and goes on by itself (docs/plan.md, Switching from Featurebase): when its page is
-- tried again, how many times that page has been tried without saving, and when a page was last saved (resuming it
-- moves "updatedAt", so a day without a page saved is told by this).
-- AlterTable
ALTER TABLE "data_import" ADD COLUMN     "resumeAt" TIMESTAMP(3),
ADD COLUMN     "tries" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "progressAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
