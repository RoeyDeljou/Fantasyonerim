-- CreateTable
CREATE TABLE "AdminInvite" (
    "id" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "createdById" TEXT,
    "createdByName" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "usedById" TEXT,
    "usedByName" TEXT,
    "revokedAt" TIMESTAMP(3),

    CONSTRAINT "AdminInvite_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "AdminInvite_tokenHash_key" ON "AdminInvite"("tokenHash");

-- CreateIndex
CREATE INDEX "AdminInvite_createdAt_id_idx" ON "AdminInvite"("createdAt" DESC, "id" DESC);

-- AddForeignKey
ALTER TABLE "AdminInvite" ADD CONSTRAINT "AdminInvite_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AdminInvite" ADD CONSTRAINT "AdminInvite_usedById_fkey" FOREIGN KEY ("usedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
