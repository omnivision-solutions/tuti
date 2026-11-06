-- Imports bring a team (docs/plan.md, Switching from Featurebase, I6) as invitations an owner or admin sends: when each
-- was emailed, null until then. The default keeps every invite made the usual way sent, the previous release's too.
-- AlterTable
ALTER TABLE "invitation" ADD COLUMN     "sentAt" TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP;

-- Invites from before it were emailed as they were made (the daily cap counts invites sent in the last day).
UPDATE "invitation" SET "sentAt" = "createdAt";
