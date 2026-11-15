-- Keeping Neon asleep: additive indexes for the per-source news reads and the expired-session sweep.

-- CreateIndex
CREATE INDEX "Session_expiresAt_idx" ON "Session"("expiresAt");

-- CreateIndex
CREATE INDEX "NewsItem_source_publishedAt_idx" ON "NewsItem"("source", "publishedAt" DESC);
