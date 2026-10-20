-- The widget's launcher settings: label, colour, corner and quick links.
-- AlterTable
ALTER TABLE "project" ADD COLUMN     "widgetColor" TEXT,
ADD COLUMN     "widgetLabel" TEXT NOT NULL DEFAULT 'Feedback',
ADD COLUMN     "widgetLinks" JSONB NOT NULL DEFAULT '[]',
ADD COLUMN     "widgetPosition" TEXT NOT NULL DEFAULT 'bottom-right';
