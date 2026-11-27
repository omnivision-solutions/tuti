-- AlterTable
ALTER TABLE "screenshot_settings" ADD COLUMN "signInServicesAt" TIMESTAMP(3),
ADD COLUMN "signInScanFor" TEXT,
ADD COLUMN "signInScanAt" TIMESTAMP(3);
