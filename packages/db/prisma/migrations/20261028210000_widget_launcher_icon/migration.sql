-- The widget launcher's icon (Customize → Widget): one of a few built in, or an uploaded image.
ALTER TABLE "project"
  ADD COLUMN "widgetIcon" TEXT NOT NULL DEFAULT 'chat',
  ADD COLUMN "widgetIconImageId" TEXT;

ALTER TABLE "project" ADD CONSTRAINT "project_widgetIconImageId_fkey" FOREIGN KEY ("widgetIconImageId") REFERENCES "media"("id") ON DELETE SET NULL ON UPDATE CASCADE;
