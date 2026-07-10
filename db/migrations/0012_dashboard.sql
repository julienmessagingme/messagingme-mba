-- Dashboard d'accueil : réglages par tenant (toggle MBA) + catégorie des templates envoyés
-- depuis l'inbox (pour splitter utility/marketing dans les stats, comme les campagnes).
create table if not exists tenant_settings (
  tenant_id   uuid primary key references tenants(id) on delete cascade,
  mba_enabled boolean not null default false,
  updated_at  timestamptz not null default now()
);

alter table conversation_messages add column if not exists template_category text;
alter table conversation_messages add column if not exists template_name text;
