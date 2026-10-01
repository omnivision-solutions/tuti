-- CreateTable
CREATE TABLE "board_redirect" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "boardId" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "board_redirect_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "board_redirect_boardId_idx" ON "board_redirect"("boardId");

-- CreateIndex
CREATE UNIQUE INDEX "board_redirect_projectId_slug_key" ON "board_redirect"("projectId", "slug");

-- AddForeignKey
ALTER TABLE "board_redirect" ADD CONSTRAINT "board_redirect_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "board_redirect" ADD CONSTRAINT "board_redirect_boardId_fkey" FOREIGN KEY ("boardId") REFERENCES "board"("id") ON DELETE CASCADE ON UPDATE CASCADE;
