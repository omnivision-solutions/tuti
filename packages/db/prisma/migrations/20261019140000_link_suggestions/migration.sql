-- CreateEnum
CREATE TYPE "LinkSuggestionStatus" AS ENUM ('PENDING', 'DISMISSED');

-- CreateTable
CREATE TABLE "link_suggestion" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "postId" TEXT NOT NULL,
    "repo" TEXT NOT NULL,
    "number" INTEGER NOT NULL,
    "url" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "similarity" DOUBLE PRECISION NOT NULL,
    "status" "LinkSuggestionStatus" NOT NULL DEFAULT 'PENDING',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "link_suggestion_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "link_suggestion_projectId_status_idx" ON "link_suggestion"("projectId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "link_suggestion_postId_url_key" ON "link_suggestion"("postId", "url");

-- AddForeignKey
ALTER TABLE "link_suggestion" ADD CONSTRAINT "link_suggestion_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "link_suggestion" ADD CONSTRAINT "link_suggestion_postId_fkey" FOREIGN KEY ("postId") REFERENCES "post"("id") ON DELETE CASCADE ON UPDATE CASCADE;

