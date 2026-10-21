-- CreateEnum
CREATE TYPE "CertificateStatus" AS ENUM ('PENDING', 'ACTIVE', 'FAILED');

-- AlterTable
ALTER TABLE "custom_domain" ADD COLUMN     "certificate" "CertificateStatus",
ADD COLUMN     "cloudflareId" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "custom_domain_cloudflareId_key" ON "custom_domain"("cloudflareId");
