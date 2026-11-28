-- Boards' translations (docs/plan.md, Languages, L14): a feedback board's name and description in the project's other languages.
ALTER TABLE "board" ADD COLUMN "translations" JSONB NOT NULL DEFAULT '{}';
