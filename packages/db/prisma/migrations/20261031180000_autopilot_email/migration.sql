-- Autopilot's email (docs/plan.md, A5): who's told (owners; the project adds admins or chosen team
-- members), each person's choice on their account, and each change's notice to each of them, sent with
-- the others merged within ten minutes.
CREATE TYPE "AutopilotEmails" AS ENUM ('AS_THEY_HAPPEN', 'OFF');

ALTER TABLE "user" ADD COLUMN "autopilotEmails" "AutopilotEmails" NOT NULL DEFAULT 'AS_THEY_HAPPEN';
ALTER TABLE "project" ADD COLUMN "autopilotTellAdmins" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "team_member" ADD COLUMN "autopilotTold" BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE "autopilot_notice" (
    "id" TEXT NOT NULL,
    "codeChangeId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "claimedAt" TIMESTAMP(3),
    "readAt" TIMESTAMP(3),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "sentAt" TIMESTAMP(3),
    "since" TIMESTAMP(3),
    "newsFrom" TIMESTAMP(3),

    CONSTRAINT "autopilot_notice_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "autopilot_notice_codeChangeId_userId_key" ON "autopilot_notice"("codeChangeId", "userId");
CREATE INDEX "autopilot_notice_sentAt_createdAt_idx" ON "autopilot_notice"("sentAt", "createdAt");

ALTER TABLE "autopilot_notice" ADD CONSTRAINT "autopilot_notice_codeChangeId_fkey" FOREIGN KEY ("codeChangeId") REFERENCES "code_change"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "autopilot_notice" ADD CONSTRAINT "autopilot_notice_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Owners hear what goes out by itself now: new projects publish article edits and post progress updates by themselves.
ALTER TABLE "project" ALTER COLUMN "autopilotArticleEdits" SET DEFAULT true;
ALTER TABLE "project" ALTER COLUMN "autopilotProgress" SET DEFAULT true;
