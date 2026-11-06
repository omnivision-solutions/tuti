-- Imported messages (docs/plan.md, Switching from Featurebase, I5): the import that brought each, so the reply emails and the widget's unread dot leave them out.
-- AlterTable
ALTER TABLE "conversation_message" ADD COLUMN "importId" TEXT;

-- AddForeignKey
ALTER TABLE "conversation_message" ADD CONSTRAINT "conversation_message_importId_fkey" FOREIGN KEY ("importId") REFERENCES "data_import"("id") ON DELETE SET NULL ON UPDATE CASCADE;
