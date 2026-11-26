-- AlterTable
ALTER TABLE "screenshot_run" ADD COLUMN     "articleId" TEXT;

-- CreateIndex
CREATE INDEX "screenshot_run_articleId_createdAt_idx" ON "screenshot_run"("articleId", "createdAt");

-- AddForeignKey
ALTER TABLE "screenshot_run" ADD CONSTRAINT "screenshot_run_articleId_fkey" FOREIGN KEY ("articleId") REFERENCES "article"("id") ON DELETE SET NULL ON UPDATE CASCADE;
