-- The AI's turn in a conversation (docs/plan.md, Inbox automation, W12): "AI answers first" for email, off until the team
-- turns it on, and the AI's questions of the docs from the Inbox.
ALTER TABLE "project" ADD COLUMN "emailAiFirst" BOOLEAN NOT NULL DEFAULT false;
ALTER TYPE "DocsQuestionSource" ADD VALUE 'INBOX';
