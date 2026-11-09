-- Additive. Gameweek Roundup: one stored roundup per (league, official GW).
-- CreateTable
CREATE TABLE "GameweekRoundup" (
    "id" TEXT NOT NULL,
    "leagueId" INTEGER NOT NULL,
    "event" INTEGER NOT NULL,
    "leagueName" TEXT NOT NULL,
    "data" JSONB NOT NULL,
    "captains" JSONB NOT NULL,
    "captainPoints" JSONB NOT NULL,
    "builtAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GameweekRoundup_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "GameweekRoundup_leagueId_event_key" ON "GameweekRoundup"("leagueId", "event");
