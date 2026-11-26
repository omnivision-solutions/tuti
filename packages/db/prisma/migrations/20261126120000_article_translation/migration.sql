-- Article translations (docs/plan.md, Languages, L6).
ALTER TABLE "project_language" ADD COLUMN "productVersion" INTEGER NOT NULL DEFAULT 0;

CREATE TABLE "article_translation" (
    "id" TEXT NOT NULL,
    "articleId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "language" TEXT NOT NULL,
    "automatic" BOOLEAN NOT NULL DEFAULT true,
    "title" TEXT NOT NULL DEFAULT '',
    "description" TEXT NOT NULL DEFAULT '',
    "keywords" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "body" TEXT NOT NULL DEFAULT '',
    "content" JSONB,
    "publishedAt" TIMESTAMP(3),
    "sourceHash" TEXT,
    "productAvailable" BOOLEAN,
    "memory" JSONB NOT NULL DEFAULT '{}',
    "behind" JSONB NOT NULL DEFAULT '{}',
    "error" TEXT,
    "tries" INTEGER NOT NULL DEFAULT 0,
    "retryAt" TIMESTAMP(3),
    "retranslate" INTEGER NOT NULL DEFAULT 0,
    "retranslated" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "article_translation_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "article_translation_articleId_language_key" ON "article_translation"("articleId", "language");
CREATE INDEX "article_translation_projectId_language_idx" ON "article_translation"("projectId", "language");
CREATE INDEX "article_translation_retryAt_idx" ON "article_translation"("retryAt");

ALTER TABLE "article_translation" ADD CONSTRAINT "article_translation_articleId_fkey" FOREIGN KEY ("articleId") REFERENCES "article"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "article_translation" ADD CONSTRAINT "article_translation_projectId_language_fkey" FOREIGN KEY ("projectId", "language") REFERENCES "project_language"("projectId", "code") ON DELETE CASCADE ON UPDATE CASCADE;
