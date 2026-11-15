-- A comment to be emailed to its post's author (comment-email): nullable, so the previous release never writes it.
ALTER TABLE "comment" ADD COLUMN "authorEmailDueAt" TIMESTAMP(3);

CREATE INDEX "comment_authorEmailDueAt_idx" ON "comment"("authorEmailDueAt");
