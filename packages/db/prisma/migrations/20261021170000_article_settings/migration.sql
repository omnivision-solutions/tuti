-- Article settings: a custom slug, a meta description, keywords and "Block search indexing".

-- AlterTable
ALTER TABLE "article" ADD COLUMN     "customSlug" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "description" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "keywords" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "noindex" BOOLEAN NOT NULL DEFAULT false;
