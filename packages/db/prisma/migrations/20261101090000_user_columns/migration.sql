-- The users' properties Users shows as columns; and posts and comments by their author, for each user's activity there.
ALTER TABLE "project" ADD COLUMN "userColumns" TEXT[] NOT NULL DEFAULT ARRAY['company', 'plan']::TEXT[];

CREATE INDEX "post_authorId_idx" ON "post"("authorId");

CREATE INDEX "comment_authorId_idx" ON "comment"("authorId");
