-- Imports from a public help center by its address.
ALTER TYPE "ImportSource" ADD VALUE 'WEBSITE';

-- What a source keeps for an import's later steps (a crawled help center's list of pages).
ALTER TABLE "data_import" ADD COLUMN "sourceState" JSONB;
