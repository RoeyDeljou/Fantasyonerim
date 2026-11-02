-- Additive. live_alerts counts each user's alerts of the current GW every two minutes during matches; the query
-- is bounded by the GW's deadline (createdAt >= deadline) so it reads only this GW's rows, not the whole
-- season-long dedupe log.
-- CreateIndex
CREATE INDEX "NotificationLog_createdAt_idx" ON "NotificationLog"("createdAt");
