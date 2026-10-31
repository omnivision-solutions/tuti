-- Autopilot's daily digest (docs/plan.md, A6): one email in the morning, in the time zone the person's
-- browser reported when they chose it, with every change still waiting for approval.
ALTER TYPE "AutopilotEmails" ADD VALUE 'DIGEST';

ALTER TABLE "user"
  ADD COLUMN "autopilotTimeZone" TEXT,
  ADD COLUMN "autopilotDigestOn" DATE;
