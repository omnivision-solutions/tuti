-- Autopilot's page's notice that edits no longer go out by themselves with Checks off, dismissed for the project (docs/plan.md, E5).
-- AlterTable
ALTER TABLE "project" ADD COLUMN "autopilotChecksNoticeDismissed" BOOLEAN NOT NULL DEFAULT false;
