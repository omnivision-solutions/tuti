-- Verify (docs/plan.md, V5): each run of it on an article, and its fix as an Autopilot update with no pull request.
-- codeChangeId becomes optional, and only this release writes a row without one (a Verify run's fix). This breaks the
-- rule that a migration keeps working with the previous release: the maintainer accepted it for V5 (#512) while Tuti has
-- no users, rather than spend a release on it. While both releases run during a deploy, on an article that got a Verify
-- fix in that window, the previous release can't (its queries by article read the pull request as required; its lists,
-- found through pull requests, just leave the fix out):
-- - in its web: save the article's text in the editor or the API (articles.update), restore a version, show that
--   article's review in Autopilot, or approve, dismiss or undo an Autopilot edit on it there (publishing or discarding
--   its changes from the editor still works);
-- - in its worker: analyse a merged pull request that edits the article (writing and landing the edit, and scheduling
--   it), which fails and is retried, by the new worker once the old one is gone.
-- Each of those fails as a whole: nothing is saved half-way or lost.
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

