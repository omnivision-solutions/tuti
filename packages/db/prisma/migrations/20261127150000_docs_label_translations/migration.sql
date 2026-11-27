-- Labels' translations (docs/plan.md, Languages, L13): a docs collection's name and description and a tab's name in the
-- project's other languages, and the label translating's retries per language.
ALTER TABLE "collection" ADD COLUMN "translations" JSONB NOT NULL DEFAULT '{}';
ALTER TABLE "docs_tab" ADD COLUMN "translations" JSONB NOT NULL DEFAULT '{}';
ALTER TABLE "project_language" ADD COLUMN "labelsTries" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "labelsRetryAt" TIMESTAMP(3),
ADD COLUMN "labelsVersion" INTEGER NOT NULL DEFAULT 0;
