-- Imports' help center (docs/plan.md, Switching from Featurebase, I4): articles are made empty first, then filled; the record map says whether each one's content landed, and the title the import gave it.
-- AlterTable
ALTER TABLE "imported_record" ADD COLUMN     "contentLanded" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "madeTitle" TEXT;
