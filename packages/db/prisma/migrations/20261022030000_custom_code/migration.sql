-- Customize → Custom code: the team's CSS for the portal, and HTML for it on their own domain or site.
ALTER TABLE "project"
  ADD COLUMN "customCss" TEXT NOT NULL DEFAULT '',
  ADD COLUMN "customHtml" TEXT NOT NULL DEFAULT '';
