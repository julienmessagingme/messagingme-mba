-- 0114_channelsme.sql
-- Integration Channels Me : connexion chiffree par tenant, liens de chaine, trace des publications.
-- ⚠️ Prefixe `channelsme_` obligatoire : `channel` designe deja le tuyau (whatsapp|rcs) dans ce depot.
--
-- 🔴 TRANSACTIONNELLE ORDINAIRE, ET C EST UN CHOIX, PAS UN OUBLI. Aucune instruction de ce fichier ne
-- construit un index sans verrou d ecriture (la seule chose que Postgres refuse dans un bloc de
-- transaction) : il n y a donc aucune raison de poser `-- migrate: no-transaction`, et une bonne raison de
-- ne pas le faire. Hors transaction, une migration n a AUCUN filet (un echec a mi-parcours n annule rien et
-- le fichier est rejoue depuis le debut, ce qui oblige chaque instruction a etre idempotente). Ici les trois
-- tables et les deux colonnes entrent ensemble ou pas du tout. Les index sont poses sur des tables VIDES
-- creees dans la meme transaction : ils ne bloquent aucune ecriture, personne ne pouvant encore ecrire dedans.
--
-- 🔴 ELLE PASSE AVANT LE DEPLOIEMENT. Les deux colonnes ajoutees a `automations` seront ECRITES par le code
-- d'une tache suivante de ce lot (`PgAutomationStore.create` y inserera `possede_par` et
-- `max_fires_per_hour`) : deployer ce code-la avant cette migration ferait echouer toute creation
-- d automation en `column ... does not exist`, en boucle et en silence. C est le scenario vecu le
-- 2026-08-17, une heure et demie sans enregistrer un seul message entrant.
--
-- ⚠️ Les trois tables `channelsme_*`, elles, ne sont lues par personne tant que le module n est pas livre :
-- c est la partie NON bloquante. La regle « migrer avant de deployer » vaut pour ce que le code ECRIT.

create table if not exists channelsme_connections (
  tenant_id     uuid primary key references tenants(id) on delete cascade,
  org_id        text not null,
  channel_id    text not null,
  -- AES-256-GCM, format `v1.<iv>.<tag>.<data>` (src/crypto/secretbox.ts). Jamais lus par l'API publique.
  api_key_enc   text not null,
  secret_enc    text not null,
  verified_at   timestamptz,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create table if not exists channelsme_links (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null references tenants(id) on delete cascade,
  -- `restrict` : on ne supprime pas un scenario dont un post publie depend (cf. §4.3).
  workflow_id    uuid not null references workflows(id) on delete restrict,
  start_node_id  text,
  -- Le jeton cache, deja normalise (minuscules). C'est LUI que l'automation cherche en `contains`.
  token          text not null,
  -- La phrase que l'abonne voit avant d'envoyer.
  phrase         text not null,
  automation_id  uuid references automations(id) on delete set null,
  -- Plafond horaire PROPRE au lien (decision 3). null = plafond global de l'instance.
  max_par_heure  integer,
  created_at     timestamptz not null default now()
);

-- Un jeton doit etre unique GLOBALEMENT, pas seulement par tenant : c'est un identifiant qui circule dans
-- des messages publics et qui est cherche sur le chemin chaud.
create unique index if not exists channelsme_links_token_key on channelsme_links (token);
create index if not exists channelsme_links_tenant_idx on channelsme_links (tenant_id, created_at desc);

create table if not exists channelsme_posts (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references tenants(id) on delete cascade,
  -- Identifiant du message CHEZ Channels Me. Le statut n'est pas stocke, il se lit en direct (decision 7).
  cm_message_id text not null,
  link_id      uuid references channelsme_links(id) on delete restrict,
  created_at   timestamptz not null default now()
);
create index if not exists channelsme_posts_tenant_idx on channelsme_posts (tenant_id, created_at desc);
create unique index if not exists channelsme_posts_msg_key on channelsme_posts (tenant_id, cm_message_id);

-- Possession generique d'une automation (cf. §4.2). Additif : les webhooks existants restent exclus par
-- `trigger_kind`, aucun backfill n'est necessaire.
alter table automations add column if not exists possede_par text;

-- Plafond horaire par automation (decision 3). null = plafond global.
alter table automations add column if not exists max_fires_per_hour integer;
