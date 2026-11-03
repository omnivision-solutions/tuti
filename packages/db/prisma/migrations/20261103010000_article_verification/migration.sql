-- Verify (docs/plan.md, V5): each run of it on an article, and its fix as an Autopilot update with no pull request.
-- codeChangeId becomes optional. Only this release writes a row without one (a Verify run's fix). The previous release's
-- lists find updates through their pull request and leave such a row out, but its queries by article (taggedEdits,
-- scheduleTogether) read codeChange as required: while both run during a deploy, its requests on an article that got a
-- Verify fix in that window fail (nothing is saved or lost) until it's replaced.
-- CreateEnum
CREATE TYPE "ArticleVerificationState" AS ENUM ('RUNNING', 'DONE', 'CHANGED', 'FAILED', 'SKIPPED');

-- AlterTable
ALTER TABLE "code_change_action" ADD COLUMN     "verificationId" TEXT,
ALTER COLUMN "codeChangeId" DROP NOT NULL;

-- CreateTable
CREATE TABLE "article_verification" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "articleId" TEXT NOT NULL,
    "startedById" TEXT,
    "state" "ArticleVerificationState" NOT NULL DEFAULT 'RUNNING',
    "reason" TEXT NOT NULL DEFAULT '',
    "repo" TEXT NOT NULL DEFAULT '',
    "commit" TEXT NOT NULL DEFAULT '',
    "revisionId" TEXT,
    "versions" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "current" INTEGER NOT NULL DEFAULT 0,
    "outdated" INTEGER NOT NULL DEFAULT 0,
    "unclear" INTEGER NOT NULL DEFAULT 0,
    "statements" JSONB NOT NULL DEFAULT '[]',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "article_verification_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "article_verification_articleId_createdAt_idx" ON "article_verification"("articleId", "createdAt");

-- CreateIndex
CREATE INDEX "article_verification_projectId_idx" ON "article_verification"("projectId");

-- CreateIndex
CREATE INDEX "article_verification_startedById_idx" ON "article_verification"("startedById");

-- CreateIndex
CREATE INDEX "code_change_action_verificationId_idx" ON "code_change_action"("verificationId");

-- AddForeignKey
ALTER TABLE "code_change_action" ADD CONSTRAINT "code_change_action_verificationId_fkey" FOREIGN KEY ("verificationId") REFERENCES "article_verification"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "article_verification" ADD CONSTRAINT "article_verification_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "article_verification" ADD CONSTRAINT "article_verification_articleId_fkey" FOREIGN KEY ("articleId") REFERENCES "article"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "article_verification" ADD CONSTRAINT "article_verification_startedById_fkey" FOREIGN KEY ("startedById") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

