-- Whether a connected GitHub account is an organisation or a user: their App settings live at different addresses.
ALTER TABLE "github_installation" ADD COLUMN "accountType" TEXT NOT NULL DEFAULT 'Organization';
