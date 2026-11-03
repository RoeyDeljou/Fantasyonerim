-- Additive. Smaller WebP copies of re-hosted images (srcset): [{ width, url, key }]; NULL = not generated yet.
-- AlterTable
ALTER TABLE "NewsMedia" ADD COLUMN     "variants" JSONB;

-- AlterTable
ALTER TABLE "Upload" ADD COLUMN     "variants" JSONB;
