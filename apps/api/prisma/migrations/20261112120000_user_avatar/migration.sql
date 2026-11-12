-- Additive, deploy-safe: two nullable columns, no default, no index, no rewrite of existing rows. The previous
-- release (still serving during a Render deploy) never selects them, so it keeps working unchanged.
-- AlterTable
ALTER TABLE "User" ADD COLUMN     "avatarKey" TEXT,
ADD COLUMN     "avatarUrl" TEXT;
