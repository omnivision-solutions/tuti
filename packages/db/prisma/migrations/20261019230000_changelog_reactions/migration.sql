-- CreateEnum
CREATE TYPE "ChangelogReactionKind" AS ENUM ('THUMBS_UP', 'HEART', 'TADA');

-- CreateTable
CREATE TABLE "changelog_reaction" (
    "entryId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "kind" "ChangelogReactionKind" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "changelog_reaction_pkey" PRIMARY KEY ("entryId","userId","kind")
);

-- CreateIndex
CREATE INDEX "changelog_reaction_userId_idx" ON "changelog_reaction"("userId");

-- AddForeignKey
ALTER TABLE "changelog_reaction" ADD CONSTRAINT "changelog_reaction_entryId_fkey" FOREIGN KEY ("entryId") REFERENCES "changelog_entry"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "changelog_reaction" ADD CONSTRAINT "changelog_reaction_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

