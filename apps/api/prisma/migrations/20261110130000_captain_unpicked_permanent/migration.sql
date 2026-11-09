-- Additive relaxation: a hand-picked (PLAYER) row may have no player yet ("not picked yet for this GW"), but only for the
-- two permanent captains (COMMUNITY / FPL_LAD). Every row that satisfied the old check still satisfies this one.
-- The previous release null-checks playerId wherever it reads entries (live battle, roundup); only its admin GET
-- would reject such a row, and only after the new release has saved one.
ALTER TABLE "CaptainBattleEntry" DROP CONSTRAINT "CaptainBattleEntry_source_target_check";
ALTER TABLE "CaptainBattleEntry" ADD CONSTRAINT "CaptainBattleEntry_source_target_check" CHECK (
  ("source" = 'PLAYER' AND "entryId" IS NULL AND ("playerId" IS NOT NULL OR "kind" IN ('COMMUNITY', 'FPL_LAD')))
  OR ("source" = 'ENTRY' AND "entryId" IS NOT NULL AND "playerId" IS NULL)
);
