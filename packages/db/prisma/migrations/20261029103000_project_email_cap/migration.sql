-- A new project's daily cap, taken as its emails are sent.
ALTER TABLE "project_email_day" ADD COLUMN "claimed" INTEGER NOT NULL DEFAULT 0;
