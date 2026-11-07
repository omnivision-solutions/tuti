-- Whether an emailed-link request sent an email (SignInLink.sent): only those count toward the site's hourly limit.
ALTER TABLE "sign_in_link" ADD COLUMN "sent" BOOLEAN NOT NULL DEFAULT true;
