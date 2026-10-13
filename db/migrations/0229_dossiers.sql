-- 0229 : les dossiers qui rangent les scenarios et les templates WhatsApp (decision de Julien du 2026-10-13 ; spec
-- docs/superpowers/specs/2026-10-13-dossiers-scenarios-templates-design.md, plan du meme jour).
--
-- Un seul niveau, un dossier par element, deux listes separees (le type dit a quelle page un dossier appartient).
--  - dossiers : le nom est borne par char_length (1 a 60) et non par une repetition de regex, que Postgres refuse
--    au-dela de 255 a chaque insertion ; unique par espace et par type sans tenir compte de la casse (index
--    dossiers_nom_unique sur lower(nom)). Le plafond de 50 par type se tient dans le magasin, pas ici.
--  - workflows.dossier_id : nullable, en set null a la suppression du dossier (supprimer un dossier ne perd aucun
--    scenario). Index partiel : la mise a null le lit, et la plupart des scenarios ne sont dans aucun dossier.
--  - template_dossiers : un template vit chez Meta, pas chez nous ; il se range par son NOM (toutes ses langues
--    suivent). Aucune ligne = Sans dossier. En cascade a la suppression du dossier.
-- L espace emporte tout par cascade : aucune purge a modifier.
--
-- ORDRE : objets neufs et colonne nullable ; l ancien code ne lit rien de tout cela. Elle passe SEULE, avant le code.
-- La cle etrangere posee sur workflows prend un verrou bref sur une table du chemin chaud : lock_timeout.
set local lock_timeout = '5s';

create table if not exists dossiers (
  id         uuid primary key default gen_random_uuid(),
  tenant_id  uuid not null references tenants(id) on delete cascade,
  type       text not null constraint dossiers_type_chk check (type in ('scenario', 'template')),
  nom        text not null constraint dossiers_nom_chk check (char_length(nom) between 1 and 60),
  created_at timestamptz not null default now()
);

create unique index if not exists dossiers_nom_unique on dossiers (tenant_id, type, lower(nom));

alter table workflows add column if not exists dossier_id uuid
  constraint workflows_dossier_fk references dossiers(id) on delete set null;

create index if not exists workflows_dossier_idx on workflows (dossier_id) where dossier_id is not null;

create table if not exists template_dossiers (
  tenant_id     uuid not null references tenants(id) on delete cascade,
  template_name text not null,
  dossier_id    uuid not null constraint template_dossiers_dossier_fk references dossiers(id) on delete cascade,
  primary key (tenant_id, template_name)
);

create index if not exists template_dossiers_dossier_idx on template_dossiers (dossier_id);
