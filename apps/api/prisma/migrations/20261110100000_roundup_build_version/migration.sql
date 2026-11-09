-- Additive. Which builder version made each stored Gameweek Roundup. Rows made before this column existed are
-- version 1; the job rebuilds (and atomically replaces) any row older than ROUNDUP_BUILD_VERSION, newest GW first.
-- AlterTable
ALTER TABLE "GameweekRoundup" ADD COLUMN     "buildVersion" INTEGER NOT NULL DEFAULT 1;
