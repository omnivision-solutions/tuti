-- A project's email by day, from SES's events (sent, bounced for good, complaints), for its rates.
CREATE TABLE "project_email_day" (
    "projectId" TEXT NOT NULL,
    "day" DATE NOT NULL,
    "sent" INTEGER NOT NULL DEFAULT 0,
    "bounced" INTEGER NOT NULL DEFAULT 0,
    "complained" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "project_email_day_pkey" PRIMARY KEY ("projectId","day")
);

ALTER TABLE "project_email_day" ADD CONSTRAINT "project_email_day_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
