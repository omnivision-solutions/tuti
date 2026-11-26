-- Inbox automation (docs/plan.md, W5): who has a conversation, the AI or the team, and whether it's marked priority.
-- A new enum and two defaulted columns: the previous release reads neither, and every conversation from before is the
-- team's and not priority, as it was.
-- CreateEnum
CREATE TYPE "ConversationOwner" AS ENUM ('AI', 'TEAM');

-- AlterTable
ALTER TABLE "conversation" ADD COLUMN "handledBy" "ConversationOwner" NOT NULL DEFAULT 'TEAM',
ADD COLUMN "priority" BOOLEAN NOT NULL DEFAULT false;
