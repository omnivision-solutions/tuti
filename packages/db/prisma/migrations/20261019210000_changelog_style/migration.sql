-- AlterTable
ALTER TABLE "project" ADD COLUMN     "changelogExampleIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "changelogTone" TEXT NOT NULL DEFAULT '';
