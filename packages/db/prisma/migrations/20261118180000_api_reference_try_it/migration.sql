-- Whether an API reference's readers can send requests from its pages (docs/plan.md, A9).
-- AlterTable
ALTER TABLE "api_reference" ADD COLUMN     "tryIt" BOOLEAN NOT NULL DEFAULT true;
