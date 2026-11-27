-- Changelog translations (docs/plan.md, Languages, L16): a new table, and a nullable column the previous release doesn't read.
CREATE TABLE "changelog_translation" (
    "id" TEXT NOT NULL,
    "entryId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "language" TEXT NOT NULL,
    "automatic" BOOLEAN NOT NULL DEFAULT true,
    "title" TEXT NOT NULL DEFAULT '',
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

    CONSTRAINT "changelog_translation_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "changelog_translation_entryId_language_key" ON "changelog_translation"("entryId", "language");
CREATE INDEX "changelog_translation_projectId_language_idx" ON "changelog_translation"("projectId", "language");
CREATE INDEX "changelog_translation_retryAt_idx" ON "changelog_translation"("retryAt");

ALTER TABLE "changelog_translation" ADD CONSTRAINT "changelog_translation_entryId_fkey" FOREIGN KEY ("entryId") REFERENCES "changelog_entry"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "changelog_translation" ADD CONSTRAINT "changelog_translation_projectId_language_fkey" FOREIGN KEY ("projectId", "language") REFERENCES "project_language"("projectId", "code") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "changelog_subscriber" ADD COLUMN "language" TEXT;

-- When queuing an entry's translations failed: the retry job queues them again. Nullable, unread by the previous release.
ALTER TABLE "changelog_entry" ADD COLUMN "translationsQueueFailedAt" TIMESTAMP(3);
CREATE INDEX "changelog_entry_translationsQueueFailedAt_idx" ON "changelog_entry"("translationsQueueFailedAt");
