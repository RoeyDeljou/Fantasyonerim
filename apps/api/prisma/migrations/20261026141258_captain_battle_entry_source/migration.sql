-- CreateEnum
CREATE TYPE "CaptainBattleEntrySource" AS ENUM ('PLAYER', 'ENTRY');

-- AlterTable
ALTER TABLE "CaptainBattleEntry" ADD COLUMN     "entryId" INTEGER,
ADD COLUMN     "source" "CaptainBattleEntrySource" NOT NULL DEFAULT 'PLAYER',
ALTER COLUMN "playerId" DROP NOT NULL;
