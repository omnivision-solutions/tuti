-- Where a session was started: "app" (the app host), or the project whose portal started it, where alone it then works.
-- Sessions from before (and ones the previous release starts while it still runs) have none: they no longer work, and people sign in again once.
ALTER TABLE "session" ADD COLUMN "boundTo" TEXT;
