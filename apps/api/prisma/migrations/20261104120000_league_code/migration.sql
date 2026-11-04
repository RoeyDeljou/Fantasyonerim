-- Additive. The league's FPL invite code for the "Join our league" bar; NULL = the configured default.
-- AlterTable
ALTER TABLE "AppSettings" ADD COLUMN     "leagueCode" TEXT;
