-- Rows from before "activeAt" take their "updatedAt" as it, now that every released web and worker writes it: a
-- teammate leaving (which moves "updatedAt") no longer moves how old they are for a plan's history. Data only, so the
-- previous release keeps working. Reads keep coalesce("activeAt", "updatedAt") and its index until a later release.
UPDATE "conversation" SET "activeAt" = "updatedAt" WHERE "activeAt" IS NULL;
