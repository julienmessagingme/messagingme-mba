-- 0015_flows.sql — WhatsApp Flows (formulaires de collecte, V1 statique un seul écran).
-- flows.id = id Meta du flow (même convention que waba.id / phone_numbers.id).
-- `fields` = snapshot du constructeur (label, type, required, key) : source de vérité pour l'UI,
-- Meta ne renvoie PAS cette structure via GET /flows (seulement id/name/status/categories).
-- `status` mis à jour UNIQUEMENT par notre propre action publish (pas de sync externe en V1).
create table if not exists flows (
  id          text primary key,
  tenant_id   uuid not null references tenants(id) on delete cascade,
  name        text not null,
  status      text not null default 'DRAFT' check (status in ('DRAFT', 'PUBLISHED')),
  fields      jsonb not null default '[]'::jsonb,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index if not exists flows_tenant_idx on flows (tenant_id, created_at desc);
