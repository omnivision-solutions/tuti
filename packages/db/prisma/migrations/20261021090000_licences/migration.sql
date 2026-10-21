-- CreateTable
CREATE TABLE "installation" (
    "singleton" INTEGER NOT NULL DEFAULT 1,
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "installation_pkey" PRIMARY KEY ("singleton"),
    CONSTRAINT "installation_one_row" CHECK ("singleton" = 1)
);

-- CreateIndex
CREATE UNIQUE INDEX "installation_id_key" ON "installation"("id");

-- This installation's random id.
INSERT INTO "installation" ("id") VALUES (gen_random_uuid()::text);

-- AlterTable
ALTER TABLE "project" ADD COLUMN     "licenseKey" TEXT;
