-- 0254_passages_hubspot.sql : reprise humaine, lot 2b (plan ~/mm-hubspot/docs/2026-10-26-lot2b-cloture-relance-plan.md).
--
-- Un passage à l'équipe POUSSÉ à HubSpot (une tâche ouverte chez le conseiller) = une ligne, jusqu'à sa clôture. Un
-- balayage du worker (`hubspot-clotures`) compare chaque passage ouvert à l'état de sa conversation : clos, il prévient
-- le connecteur, qui coche la tâche (décision A). Une RELANCE (décision C) y est inscrite AVANT d'être poussée : la
-- ligne est aussi ce qui empêche de relancer deux fois le même message.
--
-- `occasion` : la clé que le connecteur connaît (`<conversation>:<escaladee_le>` pour une escalade,
-- `<conversation>:relance:<dernier entrant>` pour une relance). `depuis` : l'instant de l'escalade, ou du message
-- relancé, À LA MILLISECONDE (ce que relit le code). `clos_le` nul = ouvert. `tentee_le` : la dernière clôture refusée
-- par le connecteur (portail à re-consentir, déconnecté) ; le balayage la reporte d'une heure, sinon un espace en refus
-- occuperait toute la tête de file.
--
-- Table neuve, sans lecteur existant. ⚠️ Ses clés étrangères prennent un verrou SHARE ROW EXCLUSIVE bref sur
-- `conversations` et `tenants`, lues et écrites par le chemin chaud de chaque message : un lock_timeout de 5 s, en set
-- local. Les clés sont en cascade : la purge d'une conversation ou d'un espace emporte ses passages sans que la purge
-- ait à nommer la table (la tâche HubSpot d'une conversation purgée reste alors telle quelle).
set local lock_timeout = '5s';

create table if not exists passages_hubspot (
  occasion        text primary key,
  tenant_id       uuid not null references tenants(id) on delete cascade,
  conversation_id uuid not null references conversations(id) on delete cascade,
  nature          text not null check (nature in ('escalade', 'relance')),
  depuis          timestamptz not null,
  clos_le         timestamptz,
  tentee_le       timestamptz,
  created_at      timestamptz not null default now()
);

-- Le balayage ne lit que les passages ouverts (son `where clos_le is null`).
create index if not exists passages_hubspot_ouverts_idx on passages_hubspot (created_at) where clos_le is null;
-- « Un passage existe-t-il déjà pour ce message ? » (la relance) et la cascade depuis la conversation.
create index if not exists passages_hubspot_conversation_idx on passages_hubspot (conversation_id, depuis);
