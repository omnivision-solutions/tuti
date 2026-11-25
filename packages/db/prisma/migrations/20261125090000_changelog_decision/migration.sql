-- What the team decided about a merged pull request and the changelog (docs/plan.md, Phase 8), whatever Autopilot's
-- state, and the gate's word on a code change as its analysis saved it. A new table and a nullable column: the previous
-- release reads neither.
-- AlterTable
ALTER TABLE "code_change" ADD COLUMN     "forUsers" BOOLEAN;

-- Ones analysed before it was saved: for users where a changelog line was written for it (ready with none, only docs to
-- fix, is no more for users than nothing to do).
UPDATE "code_change" SET "forUsers" = EXISTS (
  SELECT 1 FROM "code_change_action" WHERE "code_change_action"."codeChangeId" = "code_change"."id" AND "code_change_action"."kind" = 'CHANGELOG_LINE'
) WHERE "state" IN ('READY', 'NOTHING_TO_DO');

-- CreateTable
CREATE TABLE "changelog_decision" (
    "projectId" TEXT NOT NULL,
    "repoId" INTEGER NOT NULL,
    "number" INTEGER NOT NULL,
    "repo" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "author" TEXT NOT NULL,
    "mergedAt" TIMESTAMP(3) NOT NULL,
    "takenOut" BOOLEAN NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "changelog_decision_pkey" PRIMARY KEY ("projectId","repoId","number")
);

-- AddForeignKey
ALTER TABLE "changelog_decision" ADD CONSTRAINT "changelog_decision_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

