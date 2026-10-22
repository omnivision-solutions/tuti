-- Customize → Branding → Typography: fonts for the portal's headings and text (empty: the page's own).
ALTER TABLE "project"
  ADD COLUMN "headingFont" TEXT NOT NULL DEFAULT '',
  ADD COLUMN "bodyFont" TEXT NOT NULL DEFAULT '';
