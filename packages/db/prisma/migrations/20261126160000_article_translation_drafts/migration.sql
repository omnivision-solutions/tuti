-- Retranslating and unpublished changes (docs/plan.md, Languages, L6 part three): a version's sections, its draft, and the
-- sections the team asked to translate again.
ALTER TABLE "article_translation" ADD COLUMN "sections" JSONB NOT NULL DEFAULT '[]',
ADD COLUMN "draft" JSONB,
ADD COLUMN "updateSections" JSONB NOT NULL DEFAULT '[]',
ADD COLUMN "removedSections" JSONB NOT NULL DEFAULT '[]',
ADD COLUMN "titleSource" TEXT;
