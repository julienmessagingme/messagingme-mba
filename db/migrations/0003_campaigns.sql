-- 0003_campaigns.sql — campagnes + destinataires (avec statut par destinataire).

create table if not exists campaigns (
  id                 uuid primary key default gen_random_uuid(),
  tenant_id          uuid not null references tenants(id) on delete cascade,
  phone_number_id    text not null,
  name               text not null,
  category           text not null check (category in ('marketing', 'utility')),
  template_name      text not null,
  template_language  text not null,
  param_mapping      jsonb not null default '[]'::jsonb,
  status             text not null default 'draft'
                     check (status in ('draft', 'running', 'paused', 'completed', 'failed')),
  created_at         timestamptz not null default now()
);

create table if not exists campaign_recipients (
  id               uuid primary key default gen_random_uuid(),
  campaign_id      uuid not null references campaigns(id) on delete cascade,
  contact_id       uuid not null references contacts(id) on delete cascade,
  to_e164          text not null,
  resolved_params  jsonb not null default '[]'::jsonb,
  status           text not null default 'pending'
                   check (status in ('pending', 'sent', 'failed', 'skipped')),
  message_id       text,
  error            text,
  sent_at          timestamptz,
  unique (campaign_id, contact_id)
);

create index if not exists campaign_recipients_pending_idx
  on campaign_recipients (campaign_id) where status = 'pending';
