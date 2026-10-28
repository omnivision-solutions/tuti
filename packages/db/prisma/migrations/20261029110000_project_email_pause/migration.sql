-- A project's email to its users, paused when its bounces or complaints go over (replacing approval).
ALTER TABLE "project"
  ADD COLUMN "emailPausedAt" TIMESTAMP(3),
  ADD COLUMN "emailPausedReason" TEXT,
  ADD COLUMN "emailPauseToldAt" TIMESTAMP(3),
  ADD COLUMN "emailResumedAt" TIMESTAMP(3);
