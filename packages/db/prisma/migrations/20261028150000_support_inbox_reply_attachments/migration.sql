-- Support inbox (docs/plan.md, Support inbox, item 9): the team's uploads for a reply, kept before the reply is sent (no message yet), and who uploaded them.
-- AlterTable
ALTER TABLE "conversation_attachment" ALTER COLUMN "messageId" DROP NOT NULL,
ADD COLUMN     "uploadedById" TEXT;
