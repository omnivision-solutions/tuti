-- Free trials (docs/plan.md, Plans): when a project's trial ends, and when an account's first project started one.
ALTER TABLE "project" ADD COLUMN "trialEndsAt" TIMESTAMP(3);
ALTER TABLE "user" ADD COLUMN "trialStartedAt" TIMESTAMP(3);

-- One trial an account, on its first project: an account that already made a project (its first owner) has had its
-- first. An owner invited to someone else's project hasn't, and keeps theirs.
UPDATE "user" u SET "trialStartedAt" = made.first
FROM (SELECT tm."userId", min(p."createdAt") AS first FROM team_member tm JOIN project p ON p.id = tm."projectId"
  WHERE tm.role = 'OWNER' AND NOT EXISTS (SELECT 1 FROM team_member o WHERE o."projectId" = tm."projectId" AND o.role = 'OWNER' AND o."createdAt" < tm."createdAt")
  GROUP BY tm."userId") made
WHERE u.id = made."userId" AND u."trialStartedAt" IS NULL;
