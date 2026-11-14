-- The plan enum, replaced by "planKey" (20261113180000_plan_keys): unwritten since the release after it, and out of
-- Prisma's schema since the one after that, so no released code reads or writes it.
-- Previous release: the previous release's schema has no "plan" column (only "planKey"), so it never selects it.
ALTER TABLE "project" DROP COLUMN "plan";
-- Previous release: nothing uses the type once its only column is gone.
DROP TYPE "Plan";
