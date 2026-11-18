-- When an API reference's source was last read, worked or not: a URL is read again 6 hours after (docs/plan.md, API reference in Docs, A10).
-- AlterTable
ALTER TABLE "api_reference" ADD COLUMN "syncTriedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- CreateIndex
CREATE INDEX "api_reference_source_syncTriedAt_idx" ON "api_reference"("source", "syncTriedAt");

-- Specs fetched from a URL at the team's asking, counted for their rate limits.
-- CreateTable
CREATE TABLE "api_reference_fetch" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "api_reference_fetch_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "api_reference_fetch_projectId_createdAt_idx" ON "api_reference_fetch"("projectId", "createdAt");

-- CreateIndex
CREATE INDEX "api_reference_fetch_userId_createdAt_idx" ON "api_reference_fetch"("userId", "createdAt");

-- AddForeignKey
ALTER TABLE "api_reference_fetch" ADD CONSTRAINT "api_reference_fetch_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
