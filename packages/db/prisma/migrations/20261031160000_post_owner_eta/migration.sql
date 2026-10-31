-- Who on the team looks after a post, and when they expect it (a month).
ALTER TABLE "post" ADD COLUMN "ownerId" TEXT;
ALTER TABLE "post" ADD COLUMN "eta" TIMESTAMP(3);

CREATE INDEX "post_ownerId_idx" ON "post"("ownerId");

ALTER TABLE "post" ADD CONSTRAINT "post_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;
