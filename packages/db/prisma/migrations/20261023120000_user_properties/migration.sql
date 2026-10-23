-- Users' attributes are their properties now (the column keeps its name: see SsoIdentity.properties).

-- Emails lowercase, so a reader signing in by email finds the user with their address.
UPDATE "sso_identity" SET "email" = lower("email") WHERE "email" <> lower("email");

CREATE INDEX "sso_identity_projectId_email_idx" ON "sso_identity"("projectId", "email");
