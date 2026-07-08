-- 0009_inbox.sql — boîte de réception : conversations entrantes + messages.
-- Un message entrant (réponse client, tap de bouton quick-reply) est rattaché à une
-- conversation par tenant + wa_id (numéro du client). Les réponses sortantes de l'agent
-- y sont aussi journalisées.

create table if not exists conversations (
  id               uuid primary key default gen_random_uuid(),
  tenant_id        uuid not null references tenants(id) on delete cascade,
  wa_id            text not null,                 -- numéro du client (ou BSUID)
  contact_id       uuid references contacts(id) on delete set null,
  last_message_at  timestamptz not null default now(),
  last_preview     text,
  created_at       timestamptz not null default now(),
  unique (tenant_id, wa_id)
);

create table if not exists conversation_messages (
  id               uuid primary key default gen_random_uuid(),
  conversation_id  uuid not null references conversations(id) on delete cascade,
  direction        text not null check (direction in ('in', 'out')),
  type             text,                          -- text | button | interactive | ...
  body             text,
  button_payload   text,                          -- payload d'un bouton quick-reply tapé
  meta_message_id  text,                          -- wamid (idempotence)
  created_at       timestamptz not null default now()
);

create index if not exists conversation_messages_conv_idx
  on conversation_messages (conversation_id, created_at);
create unique index if not exists conversation_messages_wamid_uidx
  on conversation_messages (meta_message_id) where meta_message_id is not null;
