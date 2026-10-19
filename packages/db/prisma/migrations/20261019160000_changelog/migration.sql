-- CreateEnum
CREATE TYPE "ChangelogTag" AS ENUM ('NEW', 'IMPROVED', 'FIXED', 'BREAKING');

-- AlterTable
ALTER TABLE "project" ADD COLUMN     "changelogCount" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "changelog_entry" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "number" INTEGER NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL DEFAULT '',
    "content" JSONB,
    "tags" "ChangelogTag"[],
    "publishedAt" TIMESTAMP(3),
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "changelog_entry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "changelog_entry_post" (
    "entryId" TEXT NOT NULL,
    "postId" TEXT NOT NULL,

    CONSTRAINT "changelog_entry_post_pkey" PRIMARY KEY ("entryId","postId")
);

-- CreateIndex
CREATE INDEX "changelog_entry_projectId_publishedAt_idx" ON "changelog_entry"("projectId", "publishedAt");

-- CreateIndex
CREATE UNIQUE INDEX "changelog_entry_projectId_number_key" ON "changelog_entry"("projectId", "number");

-- CreateIndex
CREATE INDEX "changelog_entry_post_postId_idx" ON "changelog_entry_post"("postId");

-- AddForeignKey
ALTER TABLE "changelog_entry" ADD CONSTRAINT "changelog_entry_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "changelog_entry_post" ADD CONSTRAINT "changelog_entry_post_entryId_fkey" FOREIGN KEY ("entryId") REFERENCES "changelog_entry"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "changelog_entry_post" ADD CONSTRAINT "changelog_entry_post_postId_fkey" FOREIGN KEY ("postId") REFERENCES "post"("id") ON DELETE CASCADE ON UPDATE CASCADE;

