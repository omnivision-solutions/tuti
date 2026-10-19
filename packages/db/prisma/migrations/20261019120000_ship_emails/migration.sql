-- AlterTable
ALTER TABLE "user" ADD COLUMN     "unsubscribeToken" TEXT NOT NULL DEFAULT gen_random_uuid()::text;

-- AlterTable
ALTER TABLE "post" ADD COLUMN     "shippedEmailedAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "email_opt_out" (
    "userId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "email_opt_out_pkey" PRIMARY KEY ("userId","projectId")
);

-- CreateIndex
CREATE UNIQUE INDEX "user_unsubscribeToken_key" ON "user"("unsubscribeToken");

-- AddForeignKey
ALTER TABLE "email_opt_out" ADD CONSTRAINT "email_opt_out_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "email_opt_out" ADD CONSTRAINT "email_opt_out_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

