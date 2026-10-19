-- AlterTable
ALTER TABLE "user" ADD COLUMN     "unsubscribeToken" TEXT NOT NULL DEFAULT gen_random_uuid()::text;

-- CreateTable
CREATE TABLE "email_opt_out" (
    "userId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "email_opt_out_pkey" PRIMARY KEY ("userId","projectId")
);

-- CreateTable
CREATE TABLE "shipped_email" (
    "postId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "shipped_email_pkey" PRIMARY KEY ("postId","userId")
);

-- CreateIndex
CREATE INDEX "shipped_email_userId_idx" ON "shipped_email"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "user_unsubscribeToken_key" ON "user"("unsubscribeToken");

-- AddForeignKey
ALTER TABLE "email_opt_out" ADD CONSTRAINT "email_opt_out_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "email_opt_out" ADD CONSTRAINT "email_opt_out_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shipped_email" ADD CONSTRAINT "shipped_email_postId_fkey" FOREIGN KEY ("postId") REFERENCES "post"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shipped_email" ADD CONSTRAINT "shipped_email_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

