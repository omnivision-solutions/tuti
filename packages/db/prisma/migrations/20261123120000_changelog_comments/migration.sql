-- Readers' comments on published changelog entries (docs/plan.md, The widget: comments on changelog entries).
-- CreateTable
CREATE TABLE "changelog_comment" (
    "id" TEXT NOT NULL,
    "entryId" TEXT NOT NULL,
    "authorId" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "content" JSONB NOT NULL,
    "asReader" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "editedAt" TIMESTAMP(3),

    CONSTRAINT "changelog_comment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "changelog_comment_entryId_createdAt_idx" ON "changelog_comment"("entryId", "createdAt");

-- CreateIndex
CREATE INDEX "changelog_comment_authorId_idx" ON "changelog_comment"("authorId");

-- AddForeignKey
ALTER TABLE "changelog_comment" ADD CONSTRAINT "changelog_comment_entryId_fkey" FOREIGN KEY ("entryId") REFERENCES "changelog_entry"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "changelog_comment" ADD CONSTRAINT "changelog_comment_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

