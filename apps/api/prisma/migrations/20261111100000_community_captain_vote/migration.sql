-- Additive: two new tables only. The previous release (still serving during a deploy) never touches them.
CREATE TABLE "CommunityCaptainVote" (
    "id" TEXT NOT NULL,
    "event" INTEGER NOT NULL,
    "userId" TEXT NOT NULL,
    "playerId" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CommunityCaptainVote_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "CommunityCaptainResult" (
    "event" INTEGER NOT NULL,
    "status" TEXT NOT NULL,
    "source" TEXT,
    "winnerPlayerId" INTEGER,
    "tiedPlayerIds" JSONB NOT NULL DEFAULT '[]',
    "totalVotes" INTEGER NOT NULL DEFAULT 0,
    "top" JSONB NOT NULL DEFAULT '[]',
    "decidedAt" TIMESTAMP(3),
    "decidedById" TEXT,
    "adminNotifiedAt" TIMESTAMP(3),

    CONSTRAINT "CommunityCaptainResult_pkey" PRIMARY KEY ("event")
);

CREATE INDEX "CommunityCaptainVote_event_playerId_idx" ON "CommunityCaptainVote"("event", "playerId");
CREATE UNIQUE INDEX "CommunityCaptainVote_event_userId_key" ON "CommunityCaptainVote"("event", "userId");

ALTER TABLE "CommunityCaptainVote" ADD CONSTRAINT "CommunityCaptainVote_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
