-- Signing in with a password needs a verified address now (apps/web/src/lib/auth.ts). The sessions an unverified
-- password account made before that end: on the app (which no longer counts them anyway) and on portals, where
-- "Continue as" from the app made them. A single sign-on user keeps theirs: their project's app vouches for them.
DELETE FROM "session" s
USING "user" u
WHERE s."userId" = u.id
  AND NOT u."emailVerified"
  AND EXISTS (SELECT 1 FROM "account" a WHERE a."userId" = u.id AND a."providerId" = 'credential')
  AND NOT EXISTS (SELECT 1 FROM "sso_identity" i WHERE i."userId" = u.id);
