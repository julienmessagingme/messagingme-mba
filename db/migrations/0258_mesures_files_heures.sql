-- La latence des files, heure par heure, sur 30 jours (refonte de /ops, lot 1 :
-- docs/superpowers/plans/2026-10-27-ops-refonte.md). pg-boss efface ses taches terminees au bout de quelques jours :
-- l'onglet Capacite de /ops ne peut pas y lire un mois. Le worker principal recopie ici, toutes les 15 minutes,
-- l'heure en cours et la precedente (src/ops/mesures-files.pg.ts) ; la purge generale efface au-dela de 30 jours.
--
-- A appliquer AVANT le up : le code neuf ecrit la table. L'ancien code l'ignore.
create table if not exists mesures_files_heures (
  file                  text        not null,
  heure                 timestamptz not null,
  echantillons          integer     not null,
  -- Le temps pendant lequel personne ne s'occupait de la tache (cadence, concurrence).
  attente_p95_ms        integer     not null,
  -- L'attente plus le traitement : le retard que l'on ressent (ce que les bancs mesurent).
  bout_en_bout_p95_ms   integer     not null,
  bout_en_bout_max_ms   integer     not null,
  primary key (file, heure)
);
