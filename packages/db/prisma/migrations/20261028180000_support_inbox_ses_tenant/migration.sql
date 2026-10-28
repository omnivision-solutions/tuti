-- A project's Amazon SES tenant, once set up for its email (docs/plan.md, Support inbox, item 11).
ALTER TABLE "project" ADD COLUMN "sesTenant" TEXT;
