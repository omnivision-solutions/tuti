-- Customize → Content actions and Docs home: what readers can do with an article, and the docs' home's title, subtitle and popular articles.
ALTER TABLE "project"
  ADD COLUMN "articleActions" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN "articleCopyMarkdown" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN "articleOpenChatGpt" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN "articleOpenClaude" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN "articleUpdatedDate" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN "docsTitle" TEXT NOT NULL DEFAULT '',
  ADD COLUMN "docsSubtitle" TEXT NOT NULL DEFAULT '',
  ADD COLUMN "docsPopular" BOOLEAN NOT NULL DEFAULT false;
