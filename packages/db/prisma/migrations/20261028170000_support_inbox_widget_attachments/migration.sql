-- Support inbox (docs/plan.md, Support inbox, item 9): a signed-out visitor's uploads in the widget, theirs (by their token's hash) until sent.
-- AlterTable
ALTER TABLE "conversation_attachment" ADD COLUMN     "uploadedByVisitor" TEXT;
