-- AlterTable
ALTER TABLE "screenshot_run" ADD COLUMN     "changelogEntryId" TEXT,
ADD COLUMN     "placedAt" TIMESTAMP(3),
ADD COLUMN     "placedOver" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "screenshot_settings" ADD COLUMN     "networkPolicyDomains" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "networkPolicyId" TEXT,
ADD COLUMN     "otherDomains" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- CreateIndex
CREATE INDEX "screenshot_run_changelogEntryId_createdAt_idx" ON "screenshot_run"("changelogEntryId", "createdAt");

-- AddForeignKey
ALTER TABLE "screenshot_run" ADD CONSTRAINT "screenshot_run_changelogEntryId_fkey" FOREIGN KEY ("changelogEntryId") REFERENCES "changelog_entry"("id") ON DELETE SET NULL ON UPDATE CASCADE;
