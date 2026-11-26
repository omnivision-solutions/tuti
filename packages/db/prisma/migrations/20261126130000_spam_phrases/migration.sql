-- The spam filter's phrases (docs/plan.md, Inbox automation, W2): the team's list, and the one a conversation was filed
-- for. A defaulted column and a nullable one: the previous release reads and writes neither.
-- AlterTable
ALTER TABLE "project" ADD COLUMN "spamPhrases" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- AlterTable
ALTER TABLE "conversation" ADD COLUMN "spamPhrase" TEXT;
