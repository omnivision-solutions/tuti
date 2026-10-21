-- The help center is Docs, and its sections are tabs: the tables, their columns, indexes,
-- constraints and enum types are renamed in place, so every row stays.

-- help_section → docs_tab
ALTER TABLE "help_section" RENAME TO "docs_tab";
ALTER TABLE "docs_tab" RENAME CONSTRAINT "help_section_pkey" TO "docs_tab_pkey";
ALTER TABLE "docs_tab" RENAME CONSTRAINT "help_section_projectId_fkey" TO "docs_tab_projectId_fkey";
ALTER INDEX "help_section_projectId_slug_key" RENAME TO "docs_tab_projectId_slug_key";

-- collection.sectionId → collection.tabId
ALTER TABLE "collection" RENAME COLUMN "sectionId" TO "tabId";
ALTER TABLE "collection" RENAME CONSTRAINT "collection_sectionId_fkey" TO "collection_tabId_fkey";
ALTER INDEX "collection_sectionId_idx" RENAME TO "collection_tabId_idx";

-- help_search → docs_search
ALTER TABLE "help_search" RENAME TO "docs_search";
ALTER TABLE "docs_search" RENAME CONSTRAINT "help_search_pkey" TO "docs_search_pkey";
ALTER TABLE "docs_search" RENAME CONSTRAINT "help_search_projectId_fkey" TO "docs_search_projectId_fkey";
ALTER INDEX "help_search_projectId_createdAt_idx" RENAME TO "docs_search_projectId_createdAt_idx";

-- help_question → docs_question
ALTER TABLE "help_question" RENAME TO "docs_question";
ALTER TABLE "docs_question" RENAME CONSTRAINT "help_question_pkey" TO "docs_question_pkey";
ALTER TABLE "docs_question" RENAME CONSTRAINT "help_question_projectId_fkey" TO "docs_question_projectId_fkey";
ALTER INDEX "help_question_projectId_createdAt_idx" RENAME TO "docs_question_projectId_createdAt_idx";
ALTER INDEX "help_question_projectId_askerId_createdAt_idx" RENAME TO "docs_question_projectId_askerId_createdAt_idx";

-- help_gap_dismissal → docs_gap_dismissal
ALTER TABLE "help_gap_dismissal" RENAME TO "docs_gap_dismissal";
ALTER TABLE "docs_gap_dismissal" RENAME CONSTRAINT "help_gap_dismissal_pkey" TO "docs_gap_dismissal_pkey";
ALTER TABLE "docs_gap_dismissal" RENAME CONSTRAINT "help_gap_dismissal_projectId_fkey" TO "docs_gap_dismissal_projectId_fkey";

-- Enum types (their values stay)
ALTER TYPE "HelpAnswerStatus" RENAME TO "DocsAnswerStatus";
ALTER TYPE "HelpNoAnswerCause" RENAME TO "DocsNoAnswerCause";
ALTER TYPE "HelpQuestionSource" RENAME TO "DocsQuestionSource";
