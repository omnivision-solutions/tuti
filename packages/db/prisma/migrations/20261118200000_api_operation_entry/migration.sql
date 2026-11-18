-- API reference operations in the docs' search and AI answers (docs/plan.md, A14).
-- CreateTable
CREATE TABLE "api_operation_entry" (
    "id" TEXT NOT NULL,
    "referenceId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "words" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "model" TEXT,
    "contentHash" TEXT NOT NULL,
    "embedding" vector(1536),

    CONSTRAINT "api_operation_entry_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "api_operation_entry_projectId_idx" ON "api_operation_entry"("projectId");

-- CreateIndex
CREATE UNIQUE INDEX "api_operation_entry_referenceId_key_key" ON "api_operation_entry"("referenceId", "key");

-- AddForeignKey
ALTER TABLE "api_operation_entry" ADD CONSTRAINT "api_operation_entry_referenceId_fkey" FOREIGN KEY ("referenceId") REFERENCES "api_reference"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "api_operation_entry" ADD CONSTRAINT "api_operation_entry_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
