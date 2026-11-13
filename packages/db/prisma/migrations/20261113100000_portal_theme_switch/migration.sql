-- Whether readers get a light/dark switch in the portal's footer (Customize → Branding).
ALTER TABLE "project" ADD COLUMN "themeSwitch" BOOLEAN NOT NULL DEFAULT true;
