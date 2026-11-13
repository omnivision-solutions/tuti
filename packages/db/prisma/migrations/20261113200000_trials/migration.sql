-- Free trials (docs/plan.md, Plans): when a project's trial ends, and when an account's first project started one.
ALTER TABLE "project" ADD COLUMN "trialEndsAt" TIMESTAMP(3);
ALTER TABLE "user" ADD COLUMN "trialStartedAt" TIMESTAMP(3);
