-- Support inbox (docs/plan.md, Support inbox, item 4): team members' "Email me new conversations", and when the team was last emailed about a conversation.
-- AlterTable
ALTER TABLE "team_member" ADD COLUMN     "emailNewConversations" BOOLEAN NOT NULL DEFAULT true;

-- AlterTable
ALTER TABLE "conversation" ADD COLUMN     "notifiedAt" TIMESTAMP(3);

