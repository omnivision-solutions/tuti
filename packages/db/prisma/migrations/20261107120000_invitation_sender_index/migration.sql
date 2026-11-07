-- CreateIndex
CREATE INDEX "invitation_createdById_sentAt_idx" ON "invitation"("createdById", "sentAt");
