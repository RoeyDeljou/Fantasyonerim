-- Additive, deploy-safe: one nullable JSONB column, no default, no rewrite of existing rows. null means
-- DEFAULT_ASSISTANT_CONFIG. The previous release (still serving during a Render deploy) never selects it.
-- AlterTable
ALTER TABLE "AppSettings" ADD COLUMN     "assistant" JSONB;
