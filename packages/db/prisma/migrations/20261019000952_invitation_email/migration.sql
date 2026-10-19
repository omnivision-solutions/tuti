-- Invites by email: who an invitation is for. Null for older link-only invites.
ALTER TABLE "invitation" ADD COLUMN "email" TEXT;

CREATE INDEX "invitation_projectId_email_idx" ON "invitation"("projectId", "email");
