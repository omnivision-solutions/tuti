-- A new message in the widget's Messages goes to the AI first, with "Ask a person" (Customize → Widget); on unless turned off.
ALTER TABLE "project" ADD COLUMN "widgetAiFirst" BOOLEAN NOT NULL DEFAULT true;
