-- Code changes (docs/plan.md): every merged pull request, analysed into actions the team applies.
-- CreateEnum
CREATE TYPE "CodeChangeState" AS ENUM ('ANALYSING', 'READY', 'NOTHING_TO_DO', 'FAILED');

-- CreateEnum
CREATE TYPE "CodeChangeActionKind" AS ENUM ('LINKS', 'RESOLVES', 'MOVES_FORWARD', 'ARTICLE_EDIT', 'NEW_ARTICLE', 'CHANGELOG_LINE');

-- CreateEnum
CREATE TYPE "CodeChangeActionStatus" AS ENUM ('PENDING', 'APPLIED', 'DISMISSED', 'STALE');

-- AlterTable
ALTER TABLE "project" ADD COLUMN     "analyseCodeChanges" BOOLEAN NOT NULL DEFAULT true;

-- CreateTable
CREATE TABLE "code_change" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "repoId" INTEGER NOT NULL,
    "repo" TEXT NOT NULL,
    "number" INTEGER NOT NULL,
    "url" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "author" TEXT NOT NULL,
    "mergedAt" TIMESTAMP(3) NOT NULL,
    "state" "CodeChangeState" NOT NULL DEFAULT 'ANALYSING',
    "reason" TEXT NOT NULL DEFAULT '',
    "summary" TEXT NOT NULL DEFAULT '',
    "why" TEXT NOT NULL DEFAULT '',
    "model" TEXT,
    "decider" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "code_change_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "code_change_action" (
    "id" TEXT NOT NULL,
    "codeChangeId" TEXT NOT NULL,
    "kind" "CodeChangeActionKind" NOT NULL,
    "postId" TEXT,
    "articleId" TEXT,
    "probability" DOUBLE PRECISION NOT NULL,
    "reason" TEXT NOT NULL DEFAULT '',
    "payload" JSONB NOT NULL DEFAULT '{}',
    "status" "CodeChangeActionStatus" NOT NULL DEFAULT 'PENDING',
    "decidedById" TEXT,
    "decidedAt" TIMESTAMP(3),
    "dismissReason" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "code_change_action_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "code_change_projectId_createdAt_idx" ON "code_change"("projectId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "code_change_projectId_repoId_number_key" ON "code_change"("projectId", "repoId", "number");

-- CreateIndex
CREATE INDEX "code_change_action_codeChangeId_idx" ON "code_change_action"("codeChangeId");

-- CreateIndex
CREATE INDEX "code_change_action_postId_idx" ON "code_change_action"("postId");

-- CreateIndex
CREATE INDEX "code_change_action_articleId_idx" ON "code_change_action"("articleId");

-- AddForeignKey
ALTER TABLE "code_change" ADD CONSTRAINT "code_change_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "code_change_action" ADD CONSTRAINT "code_change_action_codeChangeId_fkey" FOREIGN KEY ("codeChangeId") REFERENCES "code_change"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "code_change_action" ADD CONSTRAINT "code_change_action_postId_fkey" FOREIGN KEY ("postId") REFERENCES "post"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "code_change_action" ADD CONSTRAINT "code_change_action_articleId_fkey" FOREIGN KEY ("articleId") REFERENCES "article"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "code_change_action" ADD CONSTRAINT "code_change_action_decidedById_fkey" FOREIGN KEY ("decidedById") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

