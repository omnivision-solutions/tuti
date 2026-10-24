-- AI credits (docs/plan.md, AI usage per project): grants, what each request was charged, and a project's debt.

-- CreateEnum
CREATE TYPE "AiCreditSource" AS ENUM ('FREE', 'TOPUP', 'PLAN', 'MANUAL');

-- AlterTable
ALTER TABLE "project" ADD COLUMN "aiCreditDebt" DECIMAL(20,6) NOT NULL DEFAULT 0,
ADD COLUMN "freeCreditsGrantedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "ai_usage" ADD COLUMN "credits" DECIMAL(20,6);

-- CreateTable
CREATE TABLE "ai_credit_grant" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "source" "AiCreditSource" NOT NULL,
    "credits" DECIMAL(20,6) NOT NULL,
    "remaining" DECIMAL(20,6) NOT NULL,
    "expiresAt" TIMESTAMP(3),
    "note" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ai_credit_grant_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ai_credit_grant_projectId_expiresAt_idx" ON "ai_credit_grant"("projectId", "expiresAt");

-- AddForeignKey
ALTER TABLE "ai_credit_grant" ADD CONSTRAINT "ai_credit_grant_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
