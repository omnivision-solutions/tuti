-- AlterTable
ALTER TABLE "github_installation" ADD COLUMN     "commentOnPullRequests" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "github_pr_comment" (
    "repo" TEXT NOT NULL,
    "number" INTEGER NOT NULL,
    "projectId" TEXT NOT NULL,
    "commentId" BIGINT NOT NULL,
    "body" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "github_pr_comment_pkey" PRIMARY KEY ("repo","number")
);

-- CreateIndex
CREATE INDEX "github_pr_comment_projectId_idx" ON "github_pr_comment"("projectId");

-- AddForeignKey
ALTER TABLE "github_pr_comment" ADD CONSTRAINT "github_pr_comment_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

