-- Email to a project's users is paid with email credits (credit_grant, kind EMAIL): the month's allowance given so far.
ALTER TABLE "project_email_month" ADD COLUMN "granted" INTEGER NOT NULL DEFAULT 0;
