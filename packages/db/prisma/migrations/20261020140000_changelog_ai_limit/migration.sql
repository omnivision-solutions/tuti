-- The hourly cap on AI edits to changelog entries (changelog.rewrite), per project.
-- AlterTable
ALTER TABLE "project" ADD COLUMN     "changelogAiCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "changelogAiHour" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
