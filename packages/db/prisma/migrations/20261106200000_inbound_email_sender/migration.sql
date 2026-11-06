-- CreateIndex
CREATE INDEX "inbound_email_projectId_sender_createdAt_idx" ON "inbound_email"("projectId", "sender", "createdAt");
