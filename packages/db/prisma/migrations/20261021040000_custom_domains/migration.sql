-- CreateTable
CREATE TABLE "custom_domain" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "hostname" TEXT NOT NULL,
    "verificationToken" TEXT NOT NULL,
    "verifiedAt" TIMESTAMP(3),
    "addedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "custom_domain_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "custom_domain_projectId_key" ON "custom_domain"("projectId");

-- CreateIndex
CREATE UNIQUE INDEX "custom_domain_hostname_key" ON "custom_domain"("hostname") WHERE ("verifiedAt" IS NOT NULL);

-- AddForeignKey
ALTER TABLE "custom_domain" ADD CONSTRAINT "custom_domain_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "custom_domain" ADD CONSTRAINT "custom_domain_addedById_fkey" FOREIGN KEY ("addedById") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;
