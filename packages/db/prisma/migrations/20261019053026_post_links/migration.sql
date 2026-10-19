-- CreateEnum
CREATE TYPE "PostLinkKind" AS ENUM ('PULL_REQUEST', 'ISSUE', 'RELEASE');

-- CreateEnum
CREATE TYPE "PostLinkSource" AS ENUM ('MANUAL', 'REFERENCE', 'SUGGESTED');

-- CreateTable
CREATE TABLE "post_link" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "postId" TEXT NOT NULL,
    "kind" "PostLinkKind" NOT NULL,
    "repo" TEXT NOT NULL,
    "number" INTEGER,
    "tag" TEXT,
    "url" TEXT NOT NULL,
    "title" TEXT,
    "source" "PostLinkSource" NOT NULL,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "post_link_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "post_link_projectId_repo_number_idx" ON "post_link"("projectId", "repo", "number");

-- CreateIndex
CREATE UNIQUE INDEX "post_link_postId_url_key" ON "post_link"("postId", "url");

-- AddForeignKey
ALTER TABLE "post_link" ADD CONSTRAINT "post_link_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "post_link" ADD CONSTRAINT "post_link_postId_fkey" FOREIGN KEY ("postId") REFERENCES "post"("id") ON DELETE CASCADE ON UPDATE CASCADE;
