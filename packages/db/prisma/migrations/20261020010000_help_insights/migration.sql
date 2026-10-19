-- Help center insights: readers' answers to "Was this helpful?", daily article views and searches (no IP addresses).
-- CreateTable
CREATE TABLE "article_feedback" (
    "articleId" TEXT NOT NULL,
    "readerId" TEXT NOT NULL,
    "helpful" BOOLEAN NOT NULL,
    "comment" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "article_feedback_pkey" PRIMARY KEY ("articleId","readerId")
);

-- CreateTable
CREATE TABLE "article_view_day" (
    "articleId" TEXT NOT NULL,
    "day" DATE NOT NULL,
    "views" INTEGER NOT NULL,

    CONSTRAINT "article_view_day_pkey" PRIMARY KEY ("articleId","day")
);

-- CreateTable
CREATE TABLE "help_search" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "query" TEXT NOT NULL,
    "results" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "help_search_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "help_search_projectId_createdAt_idx" ON "help_search"("projectId", "createdAt");

-- AddForeignKey
ALTER TABLE "article_feedback" ADD CONSTRAINT "article_feedback_articleId_fkey" FOREIGN KEY ("articleId") REFERENCES "article"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "article_view_day" ADD CONSTRAINT "article_view_day_articleId_fkey" FOREIGN KEY ("articleId") REFERENCES "article"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "help_search" ADD CONSTRAINT "help_search_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

