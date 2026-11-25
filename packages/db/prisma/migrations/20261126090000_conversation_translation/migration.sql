-- Inbox in the team's language (docs/plan.md L22): the team's language and the switch, the customer's language, and
-- each message's team-side text. All nullable or defaulted, so the release before this one keeps working.
ALTER TABLE "project" ADD COLUMN "teamLanguage" TEXT,
ADD COLUMN "translateConversations" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "conversation" ADD COLUMN "language" TEXT;

ALTER TABLE "conversation_message" ADD COLUMN "teamText" TEXT,
ADD COLUMN "language" TEXT,
ADD COLUMN "translationError" TEXT;
