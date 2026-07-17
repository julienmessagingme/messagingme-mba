-- Lot 8 Phase 5 : planification de campagne (lancer maintenant OU plus tard).
-- Path B (colonne + statut + sweeper) : visible et ANNULABLE, aligné sur le sweeper d'analyse.
-- ADD only (nouvelle colonne + élargissement du CHECK pour un statut EN PLUS) -> migrate AVANT le deploy :
-- le code neuf écrit le statut 'scheduled', l'ancien code ne l'écrit jamais (pas de valeur retirée).
alter table campaigns add column scheduled_at timestamptz;

-- Élargit le CHECK de statut pour accepter 'scheduled' (nom de contrainte vérifié : campaigns_status_check).
alter table campaigns drop constraint campaigns_status_check;
alter table campaigns add constraint campaigns_status_check
  check (status in ('draft', 'running', 'paused', 'completed', 'failed', 'scheduled'));

-- Balayage du sweeper : retrouver vite les campagnes programmées DUES.
create index if not exists campaigns_scheduled_idx on campaigns (scheduled_at) where status = 'scheduled';
