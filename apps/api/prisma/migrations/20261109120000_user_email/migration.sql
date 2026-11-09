-- Additive. Sign-in email (email + Team ID replaces recovery codes). Nullable: existing accounts add it later.
-- "recoveryCodeHash" / "recoveryCodeEnc" are deprecated but kept (the previous release still reads them during a
-- deploy); drop them in a later migration.
-- AlterTable
ALTER TABLE "User" ADD COLUMN     "email" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");
