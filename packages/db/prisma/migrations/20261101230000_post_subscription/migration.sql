-- Subscribe on a post: told when it ships, without voting.
CREATE TABLE "post_subscription" (
    "postId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "post_subscription_pkey" PRIMARY KEY ("postId","userId")
);

CREATE INDEX "post_subscription_userId_idx" ON "post_subscription"("userId");

ALTER TABLE "post_subscription" ADD CONSTRAINT "post_subscription_postId_fkey" FOREIGN KEY ("postId") REFERENCES "post"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "post_subscription" ADD CONSTRAINT "post_subscription_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;
