-- Lot 8 Phase 4 : débit ajustable par campagne (« vitesse du canon »).
-- null = aucun throttle (comportement historique). 1..80 messages/minute (le client ne peut que BAISSER
-- sous le plafond métier de 80/min). ADD only, aucune colonne touchée -> migrate AVANT le deploy.
alter table campaigns
  add column rate_per_minute integer
  check (rate_per_minute is null or (rate_per_minute >= 1 and rate_per_minute <= 80));
