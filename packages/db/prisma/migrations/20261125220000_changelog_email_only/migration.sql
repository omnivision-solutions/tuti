-- Email-only changelog entries (docs/plan.md S6): listed nowhere, emailed to subscribers.
ALTER TABLE "changelog_entry" ADD COLUMN "emailOnly" BOOLEAN NOT NULL DEFAULT false;
