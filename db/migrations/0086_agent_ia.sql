-- 0086_agent_ia.sql
-- Le bloc agent : la fiche, son catalogue d outils, l etat multi-tours, le journal d appels,
-- et la base de connaissance par tenant.
-- Le journal est AUSSI le grand livre de facturation : c est la meme table, volontairement.

create table if not exists agents (
  id                 uuid primary key default gen_random_uuid(),
  tenant_id          uuid not null references tenants(id) on delete cascade,
  label              text not null,
  -- Ce que l IA de setup peut ecrire, valide par ficheAgentSchema (Zod safeParse) : objectif, nom,
  -- ton, personnalite, regles de transfert et d arret, sources de connaissance.
  fiche              jsonb not null default '{}'::jsonb,
  fiche_version      int  not null default 1,
  -- Ce qu elle ne peut PAS ecrire : hors du jsonb, ecrit par un admin authentifie.
  mention_ia         text not null,
  max_tours          int  not null default 8  check (max_tours between 1 and 20),
  max_appels_outils  int  not null default 12 check (max_appels_outils between 0 and 60),
  budget_micro_eur   bigint not null default 30000 check (budget_micro_eur > 0),
  inactivite_minutes int  not null default 30 check (inactivite_minutes between 1 and 1440),
  contact_inconnu    text not null default 'lecture_seule'
                     check (contact_inconnu in ('aucun_outil','lecture_seule','tous')),
  modele             text not null,
  status             text not null default 'draft' check (status in ('draft','active','disabled')),
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);
create unique index if not exists agents_label_idx on agents (tenant_id, lower(label));

create table if not exists agent_tools (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references tenants(id) on delete cascade,
  agent_id        uuid not null references agents(id) on delete cascade,
  origin          text not null check (origin in ('mba','http','mcp')),
  -- Nom EXPOSE au modele. Charset commun OpenAI et Gemini.
  name            text not null check (name ~ '^[a-z0-9_]{1,64}$'),
  title           text not null,
  description     text not null,
  ne_pas_utiliser text not null,
  params          jsonb not null default '[]'::jsonb,
  binding         jsonb not null default '{}'::jsonb,
  output_paths    text[] not null default '{}',
  risk            text not null check (risk in ('read','write','irreversible')),
  timeout_ms      int  not null default 8000 check (timeout_ms between 1000 and 30000),
  max_bytes       int  not null default 16384 check (max_bytes between 256 and 262144),
  actif           boolean not null default false,
  active_par      uuid references users(id) on delete set null,
  active_le       timestamptz,
  -- Autonomie sur une action irreversible : reglage du CLIENT, outil par outil, pose par un
  -- administrateur (decision du 2026-08-26). Faux par defaut : cocher est un acte explicite.
  autonome        boolean not null default false,
  autonome_par    uuid references users(id) on delete set null,
  autonome_le     timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create unique index if not exists agent_tools_name_idx on agent_tools (agent_id, name);
create index if not exists agent_tools_actifs_idx on agent_tools (tenant_id, agent_id) where actif;
-- Un outil n est actif que si un humain l a active. La spec MCP exige un consentement humain
-- avant l invocation d un outil ; notre agent n a pas d humain au runtime, donc on deplace le
-- consentement du runtime vers la CONFIGURATION, et on le rend incontournable EN BASE.
alter table agent_tools drop constraint if exists agent_tools_actif_humain_chk;
alter table agent_tools add constraint agent_tools_actif_humain_chk
  check (actif = false or active_par is not null);
-- Meme doctrine pour l autonomie : cochee, elle porte le nom de qui l a cochee. C est ce qui rend
-- un incident instruisable, et c est la contrepartie du choix de deplacer la decision vers le client.
alter table agent_tools drop constraint if exists agent_tools_autonome_humain_chk;
alter table agent_tools add constraint agent_tools_autonome_humain_chk
  check (autonome = false or autonome_par is not null);

create table if not exists agent_sessions (
  id                uuid primary key default gen_random_uuid(),
  tenant_id         uuid not null references tenants(id) on delete cascade,
  run_id            uuid not null references workflow_runs(id) on delete cascade,
  agent_id          uuid not null references agents(id) on delete cascade,
  node_id           text not null,
  wa_id             text not null,
  transcript        jsonb  not null default '[]'::jsonb,
  tours             int    not null default 0,
  appels_outils     int    not null default 0,
  tokens_in         bigint not null default 0,
  tokens_out        bigint not null default 0,
  cout_micro_eur    bigint not null default 0,
  status            text not null default 'en_cours'
                    check (status in ('en_cours','sortie','inactivite','plafond','erreur')),
  sortie            text,
  derniere_activite timestamptz not null default now(),
  created_at        timestamptz not null default now()
);
-- Une seule session vivante par parcours : l invariant est en base, pas dans une convention.
create unique index if not exists agent_sessions_run_vivante_idx
  on agent_sessions (run_id) where status = 'en_cours';
create index if not exists agent_sessions_tenant_idx on agent_sessions (tenant_id, created_at desc);

create table if not exists agent_tool_calls (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null references tenants(id) on delete cascade,
  session_id     uuid not null references agent_sessions(id) on delete cascade,
  tool_id        uuid references agent_tools(id) on delete set null,
  tool_name      text not null,
  origin         text not null,
  args_rediges   jsonb,
  status         text not null check (status in
                   ('ok','erreur_outil','refuse','timeout','erreur_protocole','budget')),
  http_status    int,
  duree_ms       int,
  taille_reponse int,
  erreur         text,
  at             timestamptz not null default now()
);
create index if not exists agent_tool_calls_session_idx on agent_tool_calls (tenant_id, session_id, at);

-- La base de connaissance par tenant : les fiches issues du scraping, editables. Recherche plein
-- texte native (tsvector), PAS de pgvector. pg_trgm (deja installe en 0032) en complement.
-- Le cast ::regconfig force la surcharge IMMUTABLE de to_tsvector (obligatoire pour une colonne generee ;
-- la surcharge a config texte est seulement STABLE et serait refusee).
create table if not exists agent_knowledge (
  id                  uuid primary key default gen_random_uuid(),
  tenant_id           uuid not null references tenants(id) on delete cascade,
  agent_id            uuid not null references agents(id) on delete cascade,
  titre               text not null,
  corps               text not null,
  source_url          text,
  derniere_lecture_at timestamptz,
  corps_tsv           tsvector generated always as
                        (to_tsvector('french'::regconfig, coalesce(titre,'') || ' ' || coalesce(corps,''))) stored,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);
create index if not exists agent_knowledge_tsv_idx on agent_knowledge using gin (corps_tsv);
create index if not exists agent_knowledge_titre_trgm_idx
  on agent_knowledge using gin (titre gin_trgm_ops);
