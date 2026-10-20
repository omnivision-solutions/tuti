-- Where a published article is served: everywhere (as before), unlisted, hidden or AI only.
-- CreateEnum
CREATE TYPE "ArticleListing" AS ENUM ('EVERYWHERE', 'UNLISTED', 'HIDDEN', 'AI_ONLY');

-- AlterTable
ALTER TABLE "article" ADD COLUMN     "listing" "ArticleListing" NOT NULL DEFAULT 'EVERYWHERE';
