-- A new announcement pops up as a card by the widget's launcher (Settings → Widget); off unless turned on.
ALTER TABLE "project" ADD COLUMN "widgetPopup" BOOLEAN NOT NULL DEFAULT false;
