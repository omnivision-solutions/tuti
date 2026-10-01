-- Rename "workspace" to "project". Renames in place, so all data is kept.

ALTER TABLE "workspace" RENAME TO "project";
ALTER TABLE "project" RENAME CONSTRAINT "workspace_pkey" TO "project_pkey";
ALTER INDEX "workspace_slug_key" RENAME TO "project_slug_key";

-- workspaceId → projectId on every table that belongs to a project
ALTER TABLE "member" RENAME COLUMN "workspaceId" TO "projectId";
ALTER TABLE "board" RENAME COLUMN "workspaceId" TO "projectId";
ALTER TABLE "post" RENAME COLUMN "workspaceId" TO "projectId";
ALTER TABLE "vote" RENAME COLUMN "workspaceId" TO "projectId";
ALTER TABLE "comment" RENAME COLUMN "workspaceId" TO "projectId";
ALTER TABLE "sso_identity" RENAME COLUMN "workspaceId" TO "projectId";
ALTER TABLE "sso_token_use" RENAME COLUMN "workspaceId" TO "projectId";
ALTER TABLE "invitation" RENAME COLUMN "workspaceId" TO "projectId";

-- Foreign keys
ALTER TABLE "member" RENAME CONSTRAINT "member_workspaceId_fkey" TO "member_projectId_fkey";
ALTER TABLE "board" RENAME CONSTRAINT "board_workspaceId_fkey" TO "board_projectId_fkey";
ALTER TABLE "post" RENAME CONSTRAINT "post_workspaceId_fkey" TO "post_projectId_fkey";
ALTER TABLE "vote" RENAME CONSTRAINT "vote_workspaceId_fkey" TO "vote_projectId_fkey";
ALTER TABLE "comment" RENAME CONSTRAINT "comment_workspaceId_fkey" TO "comment_projectId_fkey";
ALTER TABLE "sso_identity" RENAME CONSTRAINT "sso_identity_workspaceId_fkey" TO "sso_identity_projectId_fkey";
ALTER TABLE "sso_token_use" RENAME CONSTRAINT "sso_token_use_workspaceId_fkey" TO "sso_token_use_projectId_fkey";
ALTER TABLE "invitation" RENAME CONSTRAINT "invitation_workspaceId_fkey" TO "invitation_projectId_fkey";

-- Indexes
ALTER INDEX "member_workspaceId_userId_key" RENAME TO "member_projectId_userId_key";
ALTER INDEX "board_workspaceId_slug_key" RENAME TO "board_projectId_slug_key";
ALTER INDEX "post_workspaceId_number_key" RENAME TO "post_projectId_number_key";
ALTER INDEX "post_workspaceId_status_idx" RENAME TO "post_projectId_status_idx";
ALTER INDEX "sso_identity_workspaceId_externalId_key" RENAME TO "sso_identity_projectId_externalId_key";
ALTER INDEX "invitation_workspaceId_idx" RENAME TO "invitation_projectId_idx";
