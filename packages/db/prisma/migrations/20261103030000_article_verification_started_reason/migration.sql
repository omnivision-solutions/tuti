-- Verify after edits pile up (docs/plan.md, V6): why Autopilot started a run (empty: someone did).
-- AlterTable
ALTER TABLE "article_verification" ADD COLUMN     "startedReason" TEXT NOT NULL DEFAULT '';
