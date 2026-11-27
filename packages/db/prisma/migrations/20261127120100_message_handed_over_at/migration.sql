-- Inbox automation (docs/plan.md, W11): when a user's message's handover ran ("About to go to a person"), so it never
-- runs for it twice. A nullable column: the previous release doesn't read it, and its messages leave it empty.
-- AlterTable
ALTER TABLE "conversation_message" ADD COLUMN "handedOverAt" TIMESTAMP(3);
