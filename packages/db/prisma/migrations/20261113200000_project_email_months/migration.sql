-- A project's email to its users by calendar month (UTC), counted against its plan's emailsPerMonth.
CREATE TABLE "project_email_month" (
    "projectId" TEXT NOT NULL,
    "month" DATE NOT NULL,
    "emails" INTEGER NOT NULL DEFAULT 0,
    "limitToldAt" TIMESTAMP(3),

    CONSTRAINT "project_email_month_pkey" PRIMARY KEY ("projectId","month")
);

ALTER TABLE "project_email_month" ADD CONSTRAINT "project_email_month_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
