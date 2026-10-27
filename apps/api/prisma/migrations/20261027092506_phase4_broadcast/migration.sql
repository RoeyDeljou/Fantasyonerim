-- CreateTable
CREATE TABLE "Broadcast" (
    "id" TEXT NOT NULL,
    "title" TEXT,
    "text" TEXT NOT NULL,
    "uploadId" TEXT,
    "targets" TEXT[],
    "results" JSONB NOT NULL DEFAULT '[]',
    "sentById" TEXT NOT NULL,
    "sentByName" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Broadcast_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Broadcast_createdAt_id_idx" ON "Broadcast"("createdAt" DESC, "id" DESC);

-- AddForeignKey
ALTER TABLE "Broadcast" ADD CONSTRAINT "Broadcast_uploadId_fkey" FOREIGN KEY ("uploadId") REFERENCES "Upload"("id") ON DELETE SET NULL ON UPDATE CASCADE;
