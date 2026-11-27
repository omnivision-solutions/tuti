-- The source section's hash each section the team took out of an article version was taken out at (docs/plan.md L11): on a
-- version kept up to date, one whose English changed since comes back. A defaulted column the previous release doesn't read.
ALTER TABLE "article_translation" ADD COLUMN "removedHashes" JSONB NOT NULL DEFAULT '{}';
