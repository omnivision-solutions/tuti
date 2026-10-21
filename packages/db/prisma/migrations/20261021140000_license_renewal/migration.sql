-- AlterTable
ALTER TABLE "installation" ADD COLUMN     "latestSeenAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "project" ADD COLUMN     "licenseCheckedAt" TIMESTAMP(3),
ADD COLUMN     "licenseRequestId" TEXT,
ADD COLUMN     "licenseRequestedAt" TIMESTAMP(3),
ADD COLUMN     "licenseToken" TEXT;
