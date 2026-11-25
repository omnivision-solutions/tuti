-- Languages (docs/plan.md, L4): a signed-in reader's language, and "Send visitors to their language".
ALTER TABLE "user" ADD COLUMN "language" TEXT;
ALTER TABLE "project" ADD COLUMN "sendToLanguage" BOOLEAN NOT NULL DEFAULT false;
