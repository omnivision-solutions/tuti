-- Glossary (docs/plan.md, Languages, L12): the project's terms, and the glossary each translation was made with.
CREATE TABLE "glossary_term" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "term" TEXT NOT NULL,
    "keep" BOOLEAN NOT NULL DEFAULT false,
    "translations" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "glossary_term_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "glossary_term_projectId_term_key" ON "glossary_term"("projectId", "term");

ALTER TABLE "glossary_term" ADD CONSTRAINT "glossary_term_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "article_translation" ADD COLUMN "glossaryHash" TEXT;
ALTER TABLE "changelog_translation" ADD COLUMN "glossaryHash" TEXT;
