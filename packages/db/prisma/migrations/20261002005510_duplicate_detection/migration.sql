-- Duplicate detection: post embeddings (pgvector) and suggestions for the team.
-- pgvector is not a "trusted" extension: a database superuser must enable it once
-- (CREATE EXTENSION vector) before this migration runs on a new database.
CREATE EXTENSION IF NOT EXISTS vector;

-- CreateEnum
CREATE TYPE "DuplicateSuggestionStatus" AS ENUM ('PENDING', 'DISMISSED');

-- CreateTable
CREATE TABLE "post_embedding" (
    "postId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "contentHash" TEXT NOT NULL,
    "embedding" vector(1536) NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "post_embedding_pkey" PRIMARY KEY ("postId")
);

-- CreateTable
CREATE TABLE "duplicate_suggestion" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "postId" TEXT NOT NULL,
    "originalId" TEXT NOT NULL,
    "similarity" DOUBLE PRECISION NOT NULL,
    "status" "DuplicateSuggestionStatus" NOT NULL DEFAULT 'PENDING',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "duplicate_suggestion_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "post_embedding_projectId_idx" ON "post_embedding"("projectId");

-- CreateIndex
CREATE INDEX "duplicate_suggestion_projectId_status_idx" ON "duplicate_suggestion"("projectId", "status");

-- CreateIndex
CREATE INDEX "duplicate_suggestion_originalId_idx" ON "duplicate_suggestion"("originalId");

-- CreateIndex
CREATE UNIQUE INDEX "duplicate_suggestion_postId_originalId_key" ON "duplicate_suggestion"("postId", "originalId");

-- AddForeignKey
ALTER TABLE "post_embedding" ADD CONSTRAINT "post_embedding_postId_fkey" FOREIGN KEY ("postId") REFERENCES "post"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "post_embedding" ADD CONSTRAINT "post_embedding_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "duplicate_suggestion" ADD CONSTRAINT "duplicate_suggestion_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "duplicate_suggestion" ADD CONSTRAINT "duplicate_suggestion_postId_fkey" FOREIGN KEY ("postId") REFERENCES "post"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "duplicate_suggestion" ADD CONSTRAINT "duplicate_suggestion_originalId_fkey" FOREIGN KEY ("originalId") REFERENCES "post"("id") ON DELETE CASCADE ON UPDATE CASCADE;
