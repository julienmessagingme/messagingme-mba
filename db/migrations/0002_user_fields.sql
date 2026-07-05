-- 0002_user_fields.sql — mini-CRM : champs perso (user fields) + valeurs par contact.

-- Définitions des champs perso par tenant (équivalent user fields UChat).
create table if not exists user_fields (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references tenants(id) on delete cascade,
  key         text not null,
  label       text not null,
  type        text not null default 'text'
              check (type in ('text', 'number', 'date', 'boolean', 'url')),
  created_at  timestamptz not null default now(),
  unique (tenant_id, key)
);

-- Valeurs perso par contact : map key -> value. Colonnes illimitées sans DDL.
alter table contacts
  add column if not exists fields jsonb not null default '{}'::jsonb;
