-- Verify all (docs/plan.md, V7): a run of Verify on every published article, and each article's run in it, with what its AI cost.
-- CreateEnum
CREATE TYPE "VerifyAllState" AS ENUM ('RUNNING', 'DONE', 'STOPPED');

-- AlterTable
ALTER TABLE "article_verification" ADD COLUMN     "cost" DECIMAL(16,10),
ADD COLUMN     "verifyAllId" TEXT;

-- CreateTable
CREATE TABLE "verify_all" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "startedById" TEXT,
    "state" "VerifyAllState" NOT NULL DEFAULT 'RUNNING',
    "reason" TEXT NOT NULL DEFAULT '',
    "articleIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "taken" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "verify_all_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "verify_all_projectId_createdAt_idx" ON "verify_all"("projectId", "createdAt");

-- CreateIndex
CREATE INDEX "verify_all_startedById_idx" ON "verify_all"("startedById");

-- CreateIndex
CREATE INDEX "article_verification_verifyAllId_idx" ON "article_verification"("verifyAllId");

-- AddForeignKey
ALTER TABLE "article_verification" ADD CONSTRAINT "article_verification_verifyAllId_fkey" FOREIGN KEY ("verifyAllId") REFERENCES "verify_all"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "verify_all" ADD CONSTRAINT "verify_all_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "verify_all" ADD CONSTRAINT "verify_all_startedById_fkey" FOREIGN KEY ("startedById") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

