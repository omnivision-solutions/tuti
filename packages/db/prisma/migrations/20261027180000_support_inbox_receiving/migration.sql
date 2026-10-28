-- Support inbox (docs/plan.md, Support inbox, item 6): receiving email: each project's mail subdomain (never reused), the emails received, reply tokens (128 random bits, from Postgres's own gen_random_uuid) and what's kept of received messages.
-- CreateEnum
CREATE TYPE "InboundStatus" AS ENUM ('RECEIVED', 'ADDED', 'IGNORED', 'FAILED', 'REFUSED');

-- AlterTable
ALTER TABLE "conversation" ADD COLUMN     "replyToken" TEXT NOT NULL DEFAULT replace(gen_random_uuid()::text, '-', '');

-- AlterTable
ALTER TABLE "conversation_message" ADD COLUMN     "emailMessageId" TEXT,
ADD COLUMN     "fromAddress" TEXT,
ADD COLUMN     "original" TEXT;

-- CreateTable
CREATE TABLE "mail_subdomain" (
    "subdomain" TEXT NOT NULL,
    "projectId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "mail_subdomain_pkey" PRIMARY KEY ("subdomain")
);

-- CreateTable
CREATE TABLE "inbound_email" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "recipient" TEXT NOT NULL,
    "sender" TEXT NOT NULL,
    "subject" TEXT NOT NULL DEFAULT '',
    "messageId" TEXT,
    "dedupeKey" TEXT NOT NULL,
    "raw" BYTEA,
    "size" INTEGER NOT NULL,
    "spf" TEXT NOT NULL DEFAULT 'none',
    "dkim" TEXT NOT NULL DEFAULT 'none',
    "dmarc" TEXT NOT NULL DEFAULT 'none',
    "status" "InboundStatus" NOT NULL DEFAULT 'RECEIVED',
    "reason" TEXT NOT NULL DEFAULT '',
    "conversationId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "inbound_email_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "mail_subdomain_projectId_key" ON "mail_subdomain"("projectId");

-- CreateIndex
CREATE INDEX "inbound_email_projectId_createdAt_idx" ON "inbound_email"("projectId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "inbound_email_projectId_dedupeKey_key" ON "inbound_email"("projectId", "dedupeKey");

-- CreateIndex
CREATE UNIQUE INDEX "conversation_replyToken_key" ON "conversation"("replyToken");

-- AddForeignKey
ALTER TABLE "mail_subdomain" ADD CONSTRAINT "mail_subdomain_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "project"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inbound_email" ADD CONSTRAINT "inbound_email_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

