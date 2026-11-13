-- Free trials (docs/plan.md, Plans): when a project's trial ends, and when an account's first project started one.
ALTER TABLE "project" ADD COLUMN "trialEndsAt" TIMESTAMP(3);
ALTER TABLE "user" ADD COLUMN "trialStartedAt" TIMESTAMP(3);

-- One trial an account, on its first project: an account that already owns a project has had its first.
UPDATE "user" u SET "trialStartedAt" = owned.first
FROM (SELECT tm."userId", min(p."createdAt") AS first FROM team_member tm JOIN project p ON p.id = tm."projectId" WHERE tm.role = 'OWNER' GROUP BY tm."userId") owned
WHERE u.id = owned."userId";
