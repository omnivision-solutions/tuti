-- Autopilot's hold: an update that qualifies goes out by itself at `dueAt` (SCHEDULED); one that stops
-- qualifying waits for the team, saying why (`waitReason`). The project's switches, limits and hold.
ALTER TYPE "CodeChangeActionStatus" ADD VALUE 'SCHEDULED';

ALTER TABLE "code_change_action"
  ADD COLUMN "dueAt" TIMESTAMP(3),
  ADD COLUMN "waitReason" TEXT;

CREATE INDEX "code_change_action_dueAt_idx" ON "code_change_action"("dueAt");

ALTER TABLE "project"
  ADD COLUMN "autopilotDrafts" BOOLEAN NOT NULL DEFAULT true,
  -- Off until its owners are emailed what goes out by itself (Autopilot A5): nothing public goes out unseen.
  ADD COLUMN "autopilotArticleEdits" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "autopilotProgress" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "autopilotComplete" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "autopilotMinSure" INTEGER NOT NULL DEFAULT 95,
  ADD COLUMN "autopilotMaxReach" INTEGER NOT NULL DEFAULT 25,
  ADD COLUMN "autopilotMaxViews" INTEGER NOT NULL DEFAULT 500,
  ADD COLUMN "autopilotHoldHours" INTEGER NOT NULL DEFAULT 24;

-- New projects link posts by themselves (Autopilot's default); existing ones keep what they chose.
ALTER TABLE "project" ALTER COLUMN "autoApplyLinks" SET DEFAULT true;
