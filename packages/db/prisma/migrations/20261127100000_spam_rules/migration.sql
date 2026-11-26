-- The spam filter's block rules (docs/plan.md, Inbox automation, W2b): a new table, filled with the blocked list's
-- entries and the phrases, which this release reads no more. The previous release reads neither the table nor anything
-- changed here; what it blocks or adds as a phrase while both run isn't copied.
-- CreateTable
CREATE TABLE "spam_rule" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "field" TEXT NOT NULL,
    "matcher" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "fromReport" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "spam_rule_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "spam_rule_projectId_idx" ON "spam_rule"("projectId");

-- AddForeignKey
ALTER TABLE "spam_rule" ADD CONSTRAINT "spam_rule_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- The blocked list: an address is "Sender address is", a domain "Sender domain is" (its subdomains too, as before).
INSERT INTO "spam_rule" ("id", "projectId", "field", "matcher", "value", "createdAt")
SELECT gen_random_uuid()::text, "projectId", CASE WHEN "sender" LIKE '%@%' THEN 'sender_address' ELSE 'sender_domain' END, 'is', "sender", "decidedAt"
FROM "spam_sender" WHERE "conversationId" IS NULL AND "blocked";

-- The phrases: "Subject or body contains", whole words as before.
INSERT INTO "spam_rule" ("id", "projectId", "field", "matcher", "value")
SELECT gen_random_uuid()::text, "id", 'subject_or_body', 'contains', phrase
FROM "project", unnest("spamPhrases") AS phrase;
