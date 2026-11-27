-- The language of the page a link was asked on (docs/plan.md, Languages: emails to readers).
ALTER TABLE "sign_in_link" ADD COLUMN "language" TEXT;
