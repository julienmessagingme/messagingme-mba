-- 0018_tags_table.sql — tags PRÉ-DÉCLARÉS (lot 2 phase B). Jusqu'ici les tags étaient dérivés des
-- contacts (contacts.tags text[]) : impossible de « créer un tag » à vide. Cette table déclare des tags
-- réutilisables. listTags = union (déclarés + utilisés sur les contacts) avec le compte d'usage.
create table if not exists tags (
  tenant_id uuid not null references tenants(id) on delete cascade,
  name text not null,
  created_at timestamptz not null default now(),
  primary key (tenant_id, name)
);
