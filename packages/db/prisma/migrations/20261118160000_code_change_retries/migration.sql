-- Autopilot's analyses that failed because the AI provider didn't answer are tried again by themselves (docs/plan.md, E4).
-- AlterTable
ALTER TABLE "code_change" ADD COLUMN     "retryAt" TIMESTAMP(3),
ADD COLUMN     "retries" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "retryPastGate" BOOLEAN NOT NULL DEFAULT false;

-- CreateIndex
CREATE INDEX "code_change_retryAt_idx" ON "code_change"("retryAt");
