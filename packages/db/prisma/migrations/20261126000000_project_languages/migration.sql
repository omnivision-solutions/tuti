-- Languages (docs/plan.md, L1): a project's default language, and its others.
ALTER TABLE "project" ADD COLUMN "language" TEXT NOT NULL DEFAULT 'en';

CREATE TABLE "project_language" (
    "projectId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "automatic" BOOLEAN NOT NULL DEFAULT true,
    "instructions" TEXT NOT NULL DEFAULT '',
    "productAvailable" BOOLEAN NOT NULL DEFAULT false,
    "live" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "project_language_pkey" PRIMARY KEY ("projectId","code")
);
ALTER TABLE "project_language" ADD CONSTRAINT "project_language_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
