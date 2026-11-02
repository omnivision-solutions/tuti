-- A portal's Account: which emails about posts each person wants from the project.
CREATE TABLE "email_preference" (
    "userId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "ownPosts" BOOLEAN NOT NULL DEFAULT true,
    "followedPosts" BOOLEAN NOT NULL DEFAULT true,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "email_preference_pkey" PRIMARY KEY ("userId","projectId")
);

CREATE INDEX "email_preference_projectId_idx" ON "email_preference"("projectId");

ALTER TABLE "email_preference" ADD CONSTRAINT "email_preference_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "email_preference" ADD CONSTRAINT "email_preference_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
