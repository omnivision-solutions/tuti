-- Branding for the portal and help center: logos, favicon, colour, header and footer links, "Powered by".
-- AlterTable
ALTER TABLE "project" ADD COLUMN     "brandColor" TEXT,
ADD COLUMN     "brandFaviconId" TEXT,
ADD COLUMN     "brandLogoDarkId" TEXT,
ADD COLUMN     "brandLogoId" TEXT,
ADD COLUMN     "footerLinks" JSONB NOT NULL DEFAULT '[]',
ADD COLUMN     "headerLinks" JSONB NOT NULL DEFAULT '[]',
ADD COLUMN     "poweredBy" BOOLEAN NOT NULL DEFAULT true;

-- AddForeignKey
ALTER TABLE "project" ADD CONSTRAINT "project_brandLogoId_fkey" FOREIGN KEY ("brandLogoId") REFERENCES "media"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project" ADD CONSTRAINT "project_brandLogoDarkId_fkey" FOREIGN KEY ("brandLogoDarkId") REFERENCES "media"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project" ADD CONSTRAINT "project_brandFaviconId_fkey" FOREIGN KEY ("brandFaviconId") REFERENCES "media"("id") ON DELETE SET NULL ON UPDATE CASCADE;
