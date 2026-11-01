-- What the team will use, picked after "Create project": Home's "Get set up" follows it.
ALTER TABLE "project" ADD COLUMN "uses" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
