-- 0027_conversation_analysis.sql — passe d'analyse LLM par conversation (Pièce 1, générique / agnostique CRM).

-- Colonnes de pilotage sur la table CHAUDE conversations (petites, indexées) ; l'analyse elle-même va dans une
-- table dédiée pour ne pas alourdir le chemin inbound du webhook.
alter table conversations add column if not exists analysis_status text not null default 'pending'
  check (analysis_status in ('pending', 'queued', 'done', 'failed'));
alter table conversations add column if not exists analysis_queued_at timestamptz;
alter table conversations add column if not exists analyzed_at timestamptz;

-- Le balayage d'inactivité ne scanne que les conversations encore 'pending' (index partiel, léger).
create index if not exists conversations_analysis_pending_idx
  on conversations (last_message_at) where analysis_status = 'pending';

create table if not exists conversation_analysis (
  conversation_id   uuid primary key references conversations(id) on delete cascade,
  tenant_id         uuid not null references tenants(id) on delete cascade,
  sentiment         text not null check (sentiment in ('positif', 'neutre', 'negatif')),
  intent            text not null check (intent in ('demande_devis', 'sav', 'reclamation', 'information', 'prise_rdv', 'autre')),
  topic             text not null,
  resolved          boolean not null,
  handled_by        text not null check (handled_by in ('humain', 'automatise', 'mba')),
  exchanges_count   int not null,
  entities          jsonb not null default '{}'::jsonb,
  action_suggestion text not null check (action_suggestion in ('creer_devis', 'rappeler', 'relancer', 'escalader', 'aucune')),
  confidence        double precision not null,
  justification     text not null,
  llm_provider      text not null,
  llm_model         text not null,
  created_at        timestamptz not null default now()
);

create index if not exists conversation_analysis_tenant_idx on conversation_analysis (tenant_id, created_at);
