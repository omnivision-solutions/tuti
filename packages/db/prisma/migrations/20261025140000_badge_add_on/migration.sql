-- The "Powered by tuti" add-on on a project's plan (docs/plan.md, Plans and Licences).
ALTER TABLE "project" ADD COLUMN "badgeAddOn" BOOLEAN NOT NULL DEFAULT false;
