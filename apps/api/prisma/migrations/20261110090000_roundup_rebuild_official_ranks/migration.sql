-- One-off, safe: drop every stored Gameweek Roundup so the `gameweek_roundup` job rebuilds them with the official
-- FPL standings for the newest official GW (ranks, last ranks, totals, biggest climb / drop). No schema change.
-- The job rebuilds the newest GW on its next run (its 5-minute wait has long passed), then back-fills older GWs
-- (computed from each team's history) a few per run; until then the route answers `building` for them.
DELETE FROM "GameweekRoundup";
