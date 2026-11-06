-- Written with a portal's session: a reader's comment, never shown as the team's.
ALTER TABLE "comment" ADD COLUMN "asReader" BOOLEAN NOT NULL DEFAULT false;
