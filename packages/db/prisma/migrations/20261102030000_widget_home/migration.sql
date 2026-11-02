-- The widget's Home: its heading and greeting, and the parts the team turned off.
ALTER TABLE "project" ADD COLUMN "widgetTitle" TEXT NOT NULL DEFAULT '',
ADD COLUMN "widgetGreeting" TEXT NOT NULL DEFAULT '',
ADD COLUMN "widgetHidden" TEXT[] DEFAULT ARRAY[]::TEXT[];
