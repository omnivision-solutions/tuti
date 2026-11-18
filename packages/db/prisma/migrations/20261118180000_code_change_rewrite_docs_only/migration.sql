-- A pull request whose waiting edits are written again keeps its analyses to the help center's part until one finishes (docs/plan.md, E6).
-- AlterTable
ALTER TABLE "code_change" ADD COLUMN     "rewriteDocsOnly" BOOLEAN NOT NULL DEFAULT false;
