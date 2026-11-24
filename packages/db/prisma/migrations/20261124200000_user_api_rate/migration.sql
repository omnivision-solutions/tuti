-- The API's rate limit for a teammate's app session (server/api-auth.ts): requests in the current minute, counted on
-- their own row as a key's are on api_key. Both have defaults, so the previous release keeps working beside them.
ALTER TABLE "user" ADD COLUMN "apiRateWindowStart" TIMESTAMP(3),
ADD COLUMN "apiRateCount" INTEGER NOT NULL DEFAULT 0;
