-- The team's own cover defaults (Settings → Changelog, docs/plan.md, Phase 8): the design picked first ('' for the
-- automatic pick), and an image of theirs for the Your background design.
ALTER TABLE "project"
  ADD COLUMN "changelogCoverDesign" TEXT NOT NULL DEFAULT '',
  ADD COLUMN "changelogCoverBackgroundId" TEXT;

ALTER TABLE "project" ADD CONSTRAINT "project_changelogCoverBackgroundId_fkey" FOREIGN KEY ("changelogCoverBackgroundId") REFERENCES "media"("id") ON DELETE SET NULL ON UPDATE CASCADE;
