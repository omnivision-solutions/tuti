-- CreateEnum
CREATE TYPE "PortalAccess" AS ENUM ('PUBLIC', 'PRIVATE');

-- AlterTable
ALTER TABLE "project" ADD COLUMN "portalAccess" "PortalAccess" NOT NULL DEFAULT 'PUBLIC';
