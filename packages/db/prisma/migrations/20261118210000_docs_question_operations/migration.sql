-- The API reference operations an AI answer cites, beside its articles (docs/plan.md, A14).
-- AlterTable
ALTER TABLE "docs_question" ADD COLUMN     "operationIds" TEXT[] DEFAULT ARRAY[]::TEXT[];
