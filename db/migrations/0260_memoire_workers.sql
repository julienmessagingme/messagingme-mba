-- La mémoire de chaque worker, heure par heure (refonte de /ops, lot 2) : relevée par le worker lui-même dans son
-- groupe de contrôle, lue par l'onglet Santé (la dernière valeur) et par l'onglet Capacité (le pire de chaque heure,
-- trente jours). Une ligne par rôle et par heure, réécrite à chaque relevé. A appliquer AVANT le code qui l'écrit :
-- sans elle, le relevé échoue à chaque passe (sans toucher au battement, écrit à part).
create table if not exists memoire_workers (
  role text not null,
  heure timestamptz not null,
  max_octets bigint not null,
  dernier_octets bigint not null,
  limite_octets bigint,
  maj timestamptz not null default now(),
  primary key (role, heure)
);
