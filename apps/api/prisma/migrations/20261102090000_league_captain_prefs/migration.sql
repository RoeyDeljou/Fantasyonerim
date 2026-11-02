-- AlterTable: league + captain notification preferences (default on).
ALTER TABLE "NotificationPrefs" ADD COLUMN "league" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN "captain" BOOLEAN NOT NULL DEFAULT true;
