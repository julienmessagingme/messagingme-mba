-- 0001_init.sql — schéma foncier de la console MBA.
-- Migrations additives : chaque brique (campagnes, templates...) ajoute les siennes.
-- pg-boss gère son propre schéma (pgboss), hors de ces migrations.

create extension if not exists "pgcrypto";  -- gen_random_uuid()

-- Clients de la console.
create table if not exists tenants (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  created_at  timestamptz not null default now()
);

-- Comptes de la console. 2 rôles seulement (décision produit).
create table if not exists users (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references tenants(id) on delete cascade,
  email       text not null,
  role        text not null check (role in ('admin', 'agent')),
  created_at  timestamptz not null default now(),
  unique (tenant_id, email)
);

-- WhatsApp Business Accounts. id = id Meta du WABA.
create table if not exists waba (
  id          text primary key,
  tenant_id   uuid not null references tenants(id) on delete cascade,
  name        text,
  created_at  timestamptz not null default now()
);

-- Numéros. id = phone_number_id Meta.
create table if not exists phone_numbers (
  id                    text primary key,
  waba_id               text not null references waba(id) on delete cascade,
  tenant_id             uuid not null references tenants(id) on delete cascade,
  display_phone_number  text,
  verified_name         text,
  created_at            timestamptz not null default now()
);

-- Contacts : identité BSUID-native. Au moins un de (phone_e164, bsuid).
-- Un BSUID est scoped au business portfolio : unicité par tenant.
create table if not exists contacts (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null references tenants(id) on delete cascade,
  phone_e164     text,
  bsuid          text,
  profile_name   text,
  opt_in_status  text not null default 'unknown'
                 check (opt_in_status in ('unknown', 'opted_in', 'opted_out')),
  opt_in_source  text,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  constraint contacts_identity_present check (phone_e164 is not null or bsuid is not null)
);

create unique index if not exists contacts_tenant_phone_uidx
  on contacts (tenant_id, phone_e164) where phone_e164 is not null;
create unique index if not exists contacts_tenant_bsuid_uidx
  on contacts (tenant_id, bsuid) where bsuid is not null;

-- Log brut des webhooks entrants. meta_message_id = clé d'idempotence.
create table if not exists webhook_events (
  id               uuid primary key default gen_random_uuid(),
  received_at      timestamptz not null default now(),
  source           text,
  meta_message_id  text,
  payload          jsonb not null,
  processed_at     timestamptz,
  error            text
);

create unique index if not exists webhook_events_meta_message_id_uidx
  on webhook_events (meta_message_id) where meta_message_id is not null;
