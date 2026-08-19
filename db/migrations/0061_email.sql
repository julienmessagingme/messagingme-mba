-- 0061_email.sql : boîtes SMTP et modèles d'email par tenant, pour le node « Envoi de mail ».
-- (Numérotée 0061 : la 0060 était déjà prise par le chantier RGPD/audit d'une session concurrente.)
-- password_enc chiffré au repos (AES-256-GCM, clé ENCRYPTION_KEY) via src/crypto/secretbox.ts, comme
-- waba_credentials. Suppression douce (deleted_at) pour ne pas casser un node qui référence une boîte/modèle
-- retiré : le node devient inerte, le graphe reste valide.
create table if not exists email_accounts (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references tenants(id) on delete cascade,
  label         text not null,
  host          text not null,
  port          integer not null,
  secure        boolean not null default true,
  username      text not null,
  password_enc  text not null,
  from_address  text not null,
  from_name     text,
  reply_to      text,
  verified_at   timestamptz,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  deleted_at    timestamptz
);
create unique index if not exists email_accounts_tenant_label
  on email_accounts (tenant_id, label) where deleted_at is null;
create index if not exists email_accounts_tenant
  on email_accounts (tenant_id) where deleted_at is null;

create table if not exists email_templates (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references tenants(id) on delete cascade,
  name        text not null,
  format      text not null check (format in ('basic', 'html')),
  subject     text not null,
  body        text not null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  deleted_at  timestamptz
);
create unique index if not exists email_templates_tenant_name
  on email_templates (tenant_id, name) where deleted_at is null;
create index if not exists email_templates_tenant
  on email_templates (tenant_id) where deleted_at is null;
