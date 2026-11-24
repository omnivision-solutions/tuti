-- An import waits for its source and goes on by itself (docs/plan.md, Switching from Featurebase): when its page is
-- tried again, and how many times that page has been tried without saving.
-- AlterTable
ALTER TABLE "data_import" ADD COLUMN     "resumeAt" TIMESTAMP(3),
ADD COLUMN     "tries" INTEGER NOT NULL DEFAULT 0;
