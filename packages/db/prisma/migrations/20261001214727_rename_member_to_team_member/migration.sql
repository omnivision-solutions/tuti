-- Rename "member" to "team_member" (and the role enum to TeamRole), in place.
-- "Members" was confusing next to the users of a project's own app.

ALTER TYPE "MemberRole" RENAME TO "TeamRole";

ALTER TABLE "member" RENAME TO "team_member";
ALTER TABLE "team_member" RENAME CONSTRAINT "member_pkey" TO "team_member_pkey";
ALTER TABLE "team_member" RENAME CONSTRAINT "member_projectId_fkey" TO "team_member_projectId_fkey";
ALTER TABLE "team_member" RENAME CONSTRAINT "member_userId_fkey" TO "team_member_userId_fkey";
ALTER INDEX "member_projectId_userId_key" RENAME TO "team_member_projectId_userId_key";
ALTER INDEX "member_userId_idx" RENAME TO "team_member_userId_idx";
