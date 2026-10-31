-- The users' properties Users shows as columns; posts and comments by their author, accounts by their address
-- whatever its case, and conversations by their address, for each user's activity.
ALTER TABLE "project" ADD COLUMN "userColumns" TEXT[] NOT NULL DEFAULT ARRAY['company', 'plan']::TEXT[];

CREATE INDEX "post_authorId_idx" ON "post"("authorId");

CREATE INDEX "comment_authorId_idx" ON "comment"("authorId");

CREATE INDEX "user_lower_email_idx" ON "user"(lower("email"));

CREATE INDEX "conversation_projectId_email_idx" ON "conversation"("projectId", "email");
