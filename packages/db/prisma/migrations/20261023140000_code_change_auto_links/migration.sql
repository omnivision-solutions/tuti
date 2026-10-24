-- Code changes: a project can let Tuti apply "links" proposals by itself.
ALTER TABLE "project" ADD COLUMN "autoApplyLinks" BOOLEAN NOT NULL DEFAULT false;
