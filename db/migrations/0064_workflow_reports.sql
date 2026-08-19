-- 0064 : les TABLEAUX enregistrés d'Analytics > Mes tableaux.
--
-- Un tableau n'est qu'une SÉLECTION : un scénario, un nom, et la liste des mesures retenues dans l'ordre où
-- l'opérateur les a choisies. Aucun chiffre n'est stocké ici. C'est délibéré : recalculer à la lecture donne
-- toujours des compteurs à jour et sur la période qu'on regarde, alors qu'un total figé serait faux dès le
-- lendemain et impossible à recalculer pour une autre période.
--
-- `on delete cascade` sur le scénario : un tableau qui désigne un scénario supprimé ne mesure plus rien et ne
-- peut pas être réparé (ses mesures pointent des blocs qui n'existent plus).
create table if not exists workflow_reports (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references tenants(id) on delete cascade,
  workflow_id uuid not null references workflows(id) on delete cascade,
  name        text not null,
  -- [{ cle, label, kind, handle }] : la sélection telle que l'écran la manipule. jsonb et non des lignes
  -- filles, parce qu'elle se lit et s'écrit TOUJOURS en entier, jamais mesure par mesure.
  mesures     jsonb not null default '[]'::jsonb,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  -- Deux tableaux de même nom dans un espace ne se distingueraient plus dans le sélecteur. Le conflit sort en
  -- erreur claire au lieu de créer un doublon silencieux.
  unique (tenant_id, name)
);

create index if not exists idx_workflow_reports_tenant on workflow_reports (tenant_id, updated_at desc);
