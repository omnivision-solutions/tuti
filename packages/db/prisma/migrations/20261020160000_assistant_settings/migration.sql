-- Assistant settings per project (tone, answer length, standing instructions, off-limits
-- topics), and why each "I don't know" happened in the question log.
-- CreateEnum
CREATE TYPE "HelpNoAnswerCause" AS ENUM ('NO_RELEVANT_SECTION', 'NO_VALID_CITATION', 'SOURCE_UNPUBLISHED', 'OFF_LIMITS', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "AnswerLength" AS ENUM ('SHORT', 'MEDIUM', 'DETAILED');

-- AlterTable
ALTER TABLE "help_question" ADD COLUMN     "cause" "HelpNoAnswerCause";

-- AlterTable
ALTER TABLE "project" ADD COLUMN     "assistantInstructions" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "assistantLength" "AnswerLength" NOT NULL DEFAULT 'MEDIUM',
ADD COLUMN     "assistantOffLimits" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "assistantTone" TEXT NOT NULL DEFAULT '';

-- Questions answered "I don't know" before causes were recorded.
UPDATE "help_question" SET "cause" = 'UNKNOWN' WHERE "status" = 'NO_ANSWER';
