-- 0057_rcs.sql : agents RCS, opt-out par canal, cache de joignabilité.
--
-- Le partenaire RBM est GLOBAL (MessagingMe) : la clé de service account est unique et vit en variable
-- d'environnement serveur, jamais par tenant (à l'inverse du token Meta, résolu par MetaCredentialsResolver).
-- Ce qui isole les tenants ici, c'est le mapping agent -> tenant de cette table : toute lecture et tout envoi
-- passent par lui. `client_token_enc` est chiffré (src/crypto/secretbox.ts) et servira à valider
-- X-Goog-Signature sur le webhook entrant (lot 2).

create table if not exists rcs_agents (
  id               uuid primary key default gen_random_uuid(),
  tenant_id        uuid not null references tenants(id) on delete cascade,
  agent_id         text not null,
  brand_name       text not null,
  webhook_code     text not null unique,
  client_token_enc text not null,
  region           text not null default 'europe',
  status           text not null default 'draft',
  created_at       timestamptz not null default now(),
  unique (tenant_id, agent_id)
);

-- Opt-out PAR CANAL : un contact qui répond STOP en RCS reste joignable en WhatsApp s'il y a consenti.
alter table contacts add column if not exists rcs_optout_at timestamptz;

-- Cache de joignabilité. TTL applicatif de 7 jours : une entrée plus vieille est RÉINTERROGÉE, pas supprimée
-- (si le provider tombe, une réponse un peu vieille vaut mieux qu'une campagne qui s'arrête).
-- Sans ce cache, une campagne de 5 000 numéros ferait 5 000 appels de capacité.
create table if not exists rcs_capabilities_cache (
  agent_id    text not null,
  phone_e164  text not null,
  reachable   boolean not null,
  checked_at  timestamptz not null default now(),
  primary key (agent_id, phone_e164)
);
