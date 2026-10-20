-- CreateTable
CREATE TABLE "portal_reader_email" (
    "id" TEXT NOT NULL,
    "projectId" TEXT,
    "emailHash" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "portal_reader_email_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "portal_reader_email_projectId_createdAt_idx" ON "portal_reader_email"("projectId", "createdAt");

-- CreateIndex
CREATE INDEX "portal_reader_email_emailHash_createdAt_idx" ON "portal_reader_email"("emailHash", "createdAt");

-- CreateIndex
CREATE INDEX "portal_reader_email_createdAt_idx" ON "portal_reader_email"("createdAt");

-- AddForeignKey
ALTER TABLE "portal_reader_email" ADD CONSTRAINT "portal_reader_email_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "project"("id") ON DELETE SET NULL ON UPDATE CASCADE;

