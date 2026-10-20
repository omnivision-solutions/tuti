-- AlterTable
ALTER TABLE "collection" ADD COLUMN     "groups" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- AlterTable
ALTER TABLE "sso_identity" ADD COLUMN     "groups" TEXT[] DEFAULT ARRAY[]::TEXT[];
