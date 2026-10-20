-- AI answers: where each question was asked (portal, widget or API), and the Gaps list's dismissals.
-- CreateEnum
CREATE TYPE "HelpQuestionSource" AS ENUM ('PORTAL', 'WIDGET', 'API');

-- AlterTable: questions so far came from the portal, or from an API key (asked as the key's id).
ALTER TABLE "help_question" ADD COLUMN "source" "HelpQuestionSource" NOT NULL DEFAULT 'PORTAL';
UPDATE "help_question" q SET "source" = 'API' WHERE EXISTS (SELECT 1 FROM "api_key" k WHERE k."id" = q."askerId");
ALTER TABLE "help_question" ALTER COLUMN "source" DROP DEFAULT;

-- CreateTable
CREATE TABLE "help_gap_dismissal" (
    "projectId" TEXT NOT NULL,
    "question" TEXT NOT NULL,
    "dismissedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "help_gap_dismissal_pkey" PRIMARY KEY ("projectId","question")
);

-- AddForeignKey
ALTER TABLE "help_gap_dismissal" ADD CONSTRAINT "help_gap_dismissal_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
