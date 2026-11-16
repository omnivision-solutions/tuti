-- A post's due time now means its people's emails about the status it has (Planned and In progress too). The previous
-- release left it set on a post reopened while its shipped emails were held; the new worker would email those people
-- about the status it was reopened to. Cleared: they're due about nothing now. (The previous release's worker skips such
-- a post and clears it anyway.)
UPDATE "post" SET "shippedEmailsDueAt" = NULL WHERE "shippedEmailsDueAt" IS NOT NULL AND "status" <> 'COMPLETED';
