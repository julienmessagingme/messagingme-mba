-- 0023_workflow_runs.sql : exécution d'un workflow PAR contact (PB2). Un run avance de bloc en bloc,
-- piloté par les réponses du contact (webhook). status : waiting (attend une réponse), inbox (remonté
-- à l'humain), done (terminé). last_message_id : dédup de l'avance (webhooks Meta = at-least-once).
create table if not exists workflow_runs (
  id              uuid primary key default gen_random_uuid(),
  workflow_id     uuid not null references workflows(id) on delete cascade,
  tenant_id       uuid not null references tenants(id) on delete cascade,
  contact_id      uuid references contacts(id) on delete set null,
  wa_id           text not null,
  current_node    text,
  status          text not null default 'waiting' check (status in ('waiting', 'inbox', 'done')),
  last_message_id text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

-- Index de l'avance : retrouver LE run en attente d'un contact (par tenant + numéro).
create index if not exists workflow_runs_waiting_idx on workflow_runs (tenant_id, wa_id) where status = 'waiting';
