-- Customize → SEO, and more of Branding and Navigation: the portal's search listing, its default colour
-- scheme, text and a link for its logo, links above the docs' tree, and a "Contact us" button.
ALTER TABLE "project"
  ADD COLUMN "seoTitle" TEXT NOT NULL DEFAULT '',
  ADD COLUMN "seoDescription" TEXT NOT NULL DEFAULT '',
  ADD COLUMN "seoImageId" TEXT,
  ADD COLUMN "colorScheme" TEXT NOT NULL DEFAULT 'system',
  ADD COLUMN "logoText" TEXT NOT NULL DEFAULT '',
  ADD COLUMN "logoLink" TEXT,
  ADD COLUMN "sidebarLinks" JSONB NOT NULL DEFAULT '[]',
  ADD COLUMN "contactLabel" TEXT NOT NULL DEFAULT '',
  ADD COLUMN "contactUrl" TEXT;

ALTER TABLE "project" ADD CONSTRAINT "project_seoImageId_fkey" FOREIGN KEY ("seoImageId") REFERENCES "media"("id") ON DELETE SET NULL ON UPDATE CASCADE;
