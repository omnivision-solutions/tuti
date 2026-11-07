-- Imports from a source that can't say who may read each article ask whether its published ones come published or as drafts (docs/plan.md, Import from Ferndesk).
ALTER TABLE "data_import" ADD COLUMN "publishArticles" BOOLEAN NOT NULL DEFAULT true;
