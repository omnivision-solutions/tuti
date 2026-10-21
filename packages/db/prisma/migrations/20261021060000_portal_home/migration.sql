-- CreateEnum
CREATE TYPE "PortalHome" AS ENUM ('FEEDBACK', 'ROADMAP', 'CHANGELOG', 'DOCS');

-- AlterTable
ALTER TABLE "project" ADD COLUMN     "portalHome" "PortalHome" NOT NULL DEFAULT 'FEEDBACK';
