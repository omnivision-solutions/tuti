-- Screenshots (docs/plan.md): a project's settings, its runs and their screenshots. New tables and enums only: the
-- previous release reads none of them.
-- CreateEnum
CREATE TYPE "ScreenshotSignIn" AS ENUM ('NONE', 'PASSWORD', 'LINK');

-- CreateEnum
CREATE TYPE "ScreenshotWindow" AS ENUM ('DESKTOP', 'PHONE');

-- CreateEnum
CREATE TYPE "ScreenshotRunState" AS ENUM ('RUNNING', 'DONE', 'FAILED');

-- CreateTable
CREATE TABLE "screenshot_settings" (
    "projectId" TEXT NOT NULL,
    "appUrl" TEXT NOT NULL,
    "signIn" "ScreenshotSignIn" NOT NULL DEFAULT 'NONE',
    "username" TEXT NOT NULL DEFAULT '',
    "password" TEXT,
    "signInLink" TEXT,
    "about" TEXT NOT NULL DEFAULT '',
    "window" "ScreenshotWindow" NOT NULL DEFAULT 'DESKTOP',
    "residentialProxy" BOOLEAN NOT NULL DEFAULT false,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "screenshot_settings_pkey" PRIMARY KEY ("projectId")
);

-- CreateTable
CREATE TABLE "screenshot_run" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "startedById" TEXT,
    "test" BOOLEAN NOT NULL DEFAULT false,
    "state" "ScreenshotRunState" NOT NULL DEFAULT 'RUNNING',
    "error" TEXT NOT NULL DEFAULT '',
    "externalId" TEXT,
    "sessionId" TEXT,
    "workspaceId" TEXT,
    "cleanupAttempts" INTEGER NOT NULL DEFAULT 0,
    "cleanupAfter" TIMESTAMP(3),
    "cost" DECIMAL(16,10),
    "browserCost" DECIMAL(16,10),
    "proxyCost" DECIMAL(16,10),
    "llmCost" DECIMAL(16,10),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "screenshot_run_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "screenshot" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "show" TEXT NOT NULL,
    "imageId" TEXT,
    "width" INTEGER,
    "height" INTEGER,
    "description" TEXT NOT NULL DEFAULT '',
    "url" TEXT NOT NULL DEFAULT '',
    "failed" TEXT NOT NULL DEFAULT '',
    "cost" DECIMAL(16,10),
    "takenAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "screenshot_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "screenshot_run_projectId_test_createdAt_idx" ON "screenshot_run"("projectId", "test", "createdAt");

-- CreateIndex
CREATE INDEX "screenshot_runId_position_idx" ON "screenshot"("runId", "position");

-- CreateIndex
CREATE INDEX "screenshot_projectId_idx" ON "screenshot"("projectId");

-- AddForeignKey
ALTER TABLE "screenshot_settings" ADD CONSTRAINT "screenshot_settings_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "screenshot_run" ADD CONSTRAINT "screenshot_run_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "screenshot_run" ADD CONSTRAINT "screenshot_run_startedById_fkey" FOREIGN KEY ("startedById") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "screenshot" ADD CONSTRAINT "screenshot_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "screenshot" ADD CONSTRAINT "screenshot_runId_fkey" FOREIGN KEY ("runId") REFERENCES "screenshot_run"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "screenshot" ADD CONSTRAINT "screenshot_imageId_fkey" FOREIGN KEY ("imageId") REFERENCES "media"("id") ON DELETE SET NULL ON UPDATE CASCADE;

