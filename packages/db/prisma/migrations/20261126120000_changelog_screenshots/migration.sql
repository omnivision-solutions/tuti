-- AlterTable
ALTER TABLE "screenshot_run" ADD COLUMN     "changelogEntryId" TEXT,
ADD COLUMN     "placed" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "placedAt" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "screenshot_run_changelogEntryId_createdAt_idx" ON "screenshot_run"("changelogEntryId", "createdAt");

-- AddForeignKey
ALTER TABLE "screenshot_run" ADD CONSTRAINT "screenshot_run_changelogEntryId_fkey" FOREIGN KEY ("changelogEntryId") REFERENCES "changelog_entry"("id") ON DELETE SET NULL ON UPDATE CASCADE;
