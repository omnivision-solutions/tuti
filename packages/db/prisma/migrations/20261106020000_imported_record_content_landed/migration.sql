-- Imports' help center (docs/plan.md, Switching from Featurebase, I4): articles are made empty first, then filled; the record map says whether each one's content landed, the title the import gave it, and which import last counted it.
-- AlterTable
ALTER TABLE "imported_record" ADD COLUMN     "contentLanded" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "countedIn" TEXT,
ADD COLUMN     "madeTitle" TEXT;
