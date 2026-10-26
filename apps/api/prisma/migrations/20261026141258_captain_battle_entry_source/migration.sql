-- CreateEnum
CREATE TYPE "CaptainBattleEntrySource" AS ENUM ('PLAYER', 'ENTRY');

-- AlterTable
ALTER TABLE "CaptainBattleEntry" ADD COLUMN     "entryId" INTEGER,
ADD COLUMN     "source" "CaptainBattleEntrySource" NOT NULL DEFAULT 'PLAYER',
ALTER COLUMN "playerId" DROP NOT NULL;

-- Existing rows were all hand-picked players: they get source = PLAYER via the column default.
-- Exactly one target per source: PLAYER rows have playerId only, ENTRY rows have entryId only.
ALTER TABLE "CaptainBattleEntry" ADD CONSTRAINT "CaptainBattleEntry_source_target_check" CHECK (
  ("source" = 'PLAYER' AND "playerId" IS NOT NULL AND "entryId" IS NULL)
  OR ("source" = 'ENTRY' AND "entryId" IS NOT NULL AND "playerId" IS NULL)
);
