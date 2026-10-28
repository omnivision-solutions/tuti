-- Support inbox (docs/plan.md, Support inbox, item 9): files that came with a message, kept in the media storage, and how many couldn't be kept.
-- AlterTable
ALTER TABLE "conversation_message" ADD COLUMN     "attachmentsDropped" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "conversation_attachment" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "filename" TEXT NOT NULL,
    "contentType" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "conversation_attachment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "conversation_attachment_messageId_idx" ON "conversation_attachment"("messageId");

-- CreateIndex
CREATE INDEX "conversation_attachment_projectId_idx" ON "conversation_attachment"("projectId");

-- AddForeignKey
ALTER TABLE "conversation_attachment" ADD CONSTRAINT "conversation_attachment_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversation_attachment" ADD CONSTRAINT "conversation_attachment_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "conversation_message"("id") ON DELETE CASCADE ON UPDATE CASCADE;
