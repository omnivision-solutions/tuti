-- AI drafts can mark where a screenshot belongs, for the team to add before publishing (docs/plan.md, Phase 8): off
-- unless the team turns it on in Settings → Changelog.
-- AlterTable
ALTER TABLE "project" ADD COLUMN     "changelogScreenshotMarkers" BOOLEAN NOT NULL DEFAULT false;
