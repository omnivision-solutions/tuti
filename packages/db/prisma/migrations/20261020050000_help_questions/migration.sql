-- AI answers on the help center: the questions asked, what became of them and the asker's rating (no IP addresses).
-- CreateEnum
CREATE TYPE "HelpAnswerStatus" AS ENUM ('ANSWERED', 'NO_ANSWER', 'FAILED');

-- CreateTable
CREATE TABLE "help_question" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "askerId" TEXT NOT NULL,
    "question" TEXT NOT NULL,
    "status" "HelpAnswerStatus" NOT NULL DEFAULT 'FAILED',
    "answer" TEXT,
    "articleIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "helpful" BOOLEAN,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "help_question_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "help_question_projectId_createdAt_idx" ON "help_question"("projectId", "createdAt");

-- CreateIndex
CREATE INDEX "help_question_projectId_askerId_createdAt_idx" ON "help_question"("projectId", "askerId", "createdAt");

-- AddForeignKey
ALTER TABLE "help_question" ADD CONSTRAINT "help_question_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
