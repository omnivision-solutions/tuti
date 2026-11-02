-- The project's own sign-in page, for the portal's "Continue with <project>".
ALTER TABLE "project" ADD COLUMN "ssoSignInUrl" TEXT;
