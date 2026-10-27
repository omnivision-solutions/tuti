-- Support inbox (docs/plan.md, Support inbox, item 3): the inbox's switch, and when the user saw the team's messages.
-- AlterTable
ALTER TABLE "project" ADD COLUMN     "supportInbox" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "conversation_message" ADD COLUMN     "seenAt" TIMESTAMP(3);

