-- AlterTable
ALTER TABLE "screenshot_settings" ADD COLUMN "profileId" TEXT,
ADD COLUMN "profileSignIn" TEXT NOT NULL DEFAULT '';
