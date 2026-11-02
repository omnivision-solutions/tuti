-- An avatar uploaded from Account: the upload it's from, so the media sweep keeps it.
ALTER TABLE "user" ADD COLUMN "imageId" TEXT;
CREATE INDEX "user_imageId_idx" ON "user"("imageId");
