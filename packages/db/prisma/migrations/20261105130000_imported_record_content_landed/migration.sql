-- Imports' help center (docs/plan.md, Switching from Featurebase, I4): articles are made empty first, then filled; the record map says whether each one's content landed.
-- AlterTable
ALTER TABLE "imported_record" ADD COLUMN     "contentLanded" BOOLEAN NOT NULL DEFAULT false;
