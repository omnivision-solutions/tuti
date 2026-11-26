-- Emails past a paid plan's included ones, paid with the project's shared credits (docs/plan.md, Emails past the allowance spend credits).
ALTER TABLE "project_email_month" ADD COLUMN "paidEmails" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "project_email_month" ADD COLUMN "paidCredits" DECIMAL(20,6) NOT NULL DEFAULT 0;
