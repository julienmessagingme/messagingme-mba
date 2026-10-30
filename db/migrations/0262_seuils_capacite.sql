-- Les seuils de capacité réglables dans /ops et l'historique des alertes Telegram de Santé (refonte de /ops, lot 4).
-- Une seule ligne de seuils (comme grille_prix), signée de son auteur et de sa note ; les valeurs en JSON, validées par
-- le code (src/ops/seuils.ts) à l'écriture et relues signal par signal (un signal absent reprend son défaut).
-- A appliquer AVANT le code : sans elles, l'écran et les alertes retombent sur les seuils par défaut et la pose échoue.
create table if not exists seuils_capacite (
  id boolean primary key default true check (id),
  valeurs jsonb not null,
  modifie_le timestamptz not null default now(),
  modifie_par text not null
);

-- Chaque alerte envoyée : le dernier état d'un signal décide de la suivante (un changement d'état, au plus une fois par
-- demi-heure et par signal), et Santé montre celles des 24 h. Purgée à 30 jours par le worker.
create table if not exists alertes_capacite (
  id bigserial primary key,
  signal text not null,
  etat text not null check (etat in ('vert', 'orange', 'rouge')),
  mesure double precision,
  envoye_le timestamptz not null default now()
);

create index if not exists alertes_capacite_signal_idx on alertes_capacite (signal, envoye_le desc);
