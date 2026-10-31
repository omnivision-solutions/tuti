-- Autopilot's daily digest (docs/plan.md, A6): one email in the morning, in the time zone the person's
-- browser reported when they chose it, with every change still waiting for approval; each project's
-- digest for each of their days claimed and sent on its own.
ALTER TYPE "AutopilotEmails" ADD VALUE 'DIGEST';

ALTER TABLE "user" ADD COLUMN "autopilotTimeZone" TEXT;

CREATE TABLE "autopilot_digest" (
    "userId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "day" DATE NOT NULL,
    "claimedAt" TIMESTAMP(3),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "sentAt" TIMESTAMP(3),

    CONSTRAINT "autopilot_digest_pkey" PRIMARY KEY ("userId","projectId","day")
);

CREATE INDEX "autopilot_digest_day_idx" ON "autopilot_digest"("day");

ALTER TABLE "autopilot_digest" ADD CONSTRAINT "autopilot_digest_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "autopilot_digest" ADD CONSTRAINT "autopilot_digest_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
