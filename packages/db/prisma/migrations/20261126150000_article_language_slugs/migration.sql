-- Each language its own article slug (docs/plan.md, Languages, L6 part two), and old slugs per language.
ALTER TABLE "article_translation" ADD COLUMN "slug" TEXT,
ADD COLUMN "customSlug" BOOLEAN NOT NULL DEFAULT false;

CREATE UNIQUE INDEX "article_translation_projectId_language_slug_key" ON "article_translation"("projectId", "language", "slug");

CREATE TABLE "article_old_slug" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "language" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "articleId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "article_old_slug_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "article_old_slug_projectId_language_slug_key" ON "article_old_slug"("projectId", "language", "slug");
CREATE INDEX "article_old_slug_articleId_idx" ON "article_old_slug"("articleId");
CREATE INDEX "article_old_slug_projectId_slug_idx" ON "article_old_slug"("projectId", "slug");

ALTER TABLE "article_old_slug" ADD CONSTRAINT "article_old_slug_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "article_old_slug" ADD CONSTRAINT "article_old_slug_articleId_fkey" FOREIGN KEY ("articleId") REFERENCES "article"("id") ON DELETE CASCADE ON UPDATE CASCADE;
