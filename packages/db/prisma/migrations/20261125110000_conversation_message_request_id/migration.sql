-- AlterTable
ALTER TABLE "conversation_message" ADD COLUMN     "requestId" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "conversation_message_conversationId_author_authorId_request_key" ON "conversation_message"("conversationId", "author", "authorId", "requestId") WHERE ("requestId" IS NOT NULL);

