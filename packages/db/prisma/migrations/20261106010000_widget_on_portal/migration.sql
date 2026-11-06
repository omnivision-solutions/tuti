-- The widget's launcher on the project's own portal (Customize → Widget), on unless turned off.
ALTER TABLE "project" ADD COLUMN "widgetOnPortal" BOOLEAN NOT NULL DEFAULT true;
