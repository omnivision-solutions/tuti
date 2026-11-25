-- The mobile app's devices for push notifications (packages/jobs push.ts) and "Show message text": new tables and a
-- defaulted column, so the previous release keeps working beside them.
-- AlterTable
ALTER TABLE "user" ADD COLUMN     "pushShowsText" BOOLEAN NOT NULL DEFAULT true;

-- CreateTable
CREATE TABLE "device" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "platform" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "device_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "push_ticket" (
    "id" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "push_ticket_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "device_token_idx" ON "device"("token");

-- CreateIndex
CREATE INDEX "device_sessionId_idx" ON "device"("sessionId");

-- CreateIndex
CREATE UNIQUE INDEX "device_userId_deviceId_key" ON "device"("userId", "deviceId");

-- CreateIndex
CREATE INDEX "push_ticket_createdAt_idx" ON "push_ticket"("createdAt");

-- AddForeignKey
ALTER TABLE "device" ADD CONSTRAINT "device_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "device" ADD CONSTRAINT "device_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "session"("id") ON DELETE CASCADE ON UPDATE CASCADE;

