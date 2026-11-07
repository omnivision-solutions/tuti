-- AlterTable
ALTER TABLE "invitation" ADD COLUMN     "emailed" BOOLEAN NOT NULL DEFAULT true;

-- CreateIndex
CREATE INDEX "invitation_createdById_sentAt_idx" ON "invitation"("createdById", "sentAt");
