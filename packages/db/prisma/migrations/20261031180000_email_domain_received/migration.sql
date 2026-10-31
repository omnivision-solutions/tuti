-- When mail forwarded from a team's own address last reached its inbox (Settings → Support → Receiving emails).
ALTER TABLE "email_domain" ADD COLUMN "receivedAt" TIMESTAMP(3);
