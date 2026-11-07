-- A licence's first claim needs the installation that bought it (Installation.licenseSecret, License.claimHash).
ALTER TABLE "installation" ADD COLUMN "licenseSecret" TEXT NOT NULL DEFAULT gen_random_uuid()::text;
ALTER TABLE "license" ADD COLUMN "claimHash" TEXT;
