-- AlterTable
ALTER TABLE "screenshot_settings" ADD COLUMN "skippedDomains" TEXT[] DEFAULT ARRAY[]::TEXT[];
