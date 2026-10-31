-- This week's votes in a project (Feedback's Trending).
CREATE INDEX "vote_projectId_createdAt_idx" ON "vote"("projectId", "createdAt");
