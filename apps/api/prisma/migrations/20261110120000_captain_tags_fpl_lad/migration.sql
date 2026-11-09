-- Additive only, safe for the previous release that keeps running during a deploy: nothing in this migration writes
-- the new enum value (a value added in a transaction cannot be used in it), and the new column is nullable.
-- Existing rows are converted to FPL_LAD later, by the app's boot-time upgrader (src/league/captains.ts).
-- AlterEnum
ALTER TYPE "CaptainBattleEntryKind" ADD VALUE 'FPL_LAD';

-- AlterTable
ALTER TABLE "CaptainBattleEntry" ADD COLUMN     "tag" TEXT;
