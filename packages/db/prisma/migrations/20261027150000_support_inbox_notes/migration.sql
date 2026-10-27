-- Support inbox (docs/plan.md, Support inbox, items 3 and 10): internal notes, starting with the AI's summary of an escalated question.
-- AlterTable
ALTER TABLE "conversation_message" ADD COLUMN     "note" BOOLEAN NOT NULL DEFAULT false;

