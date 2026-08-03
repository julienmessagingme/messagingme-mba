-- Automation (Lot E) : déclencher un scénario sur un ÉVÉNEMENT, au lieu d'une campagne uniquement.
--
-- `automations` porte elle-même son état actif (`enabled`) : les workflows n'ont volontairement plus de statut
-- draft/active (migration 0030), et un même scénario peut servir à la fois une campagne et une automation.
--
-- `trigger_config` (opaque, validé côté route/code) dépend de `trigger_kind` :
--   keyword      -> { keywords: string[], mode: 'contains' | 'equals' }
--   new_contact  -> {} (1er message d'un contact inconnu)
--   tag_added    -> { tag: string }
-- `condition_group` réutilise TEL QUEL le ConditionGroup du node « Si » (workflow/conditions.ts) : filtre
-- supplémentaire évalué sur l'état du contact au moment du déclenchement. null = aucune condition.
create table if not exists automations (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  name text not null,
  enabled boolean not null default false,
  trigger_kind text not null,
  trigger_config jsonb not null default '{}'::jsonb,
  condition_group jsonb,
  workflow_id uuid not null references workflows(id) on delete cascade,
  -- Démarrage à un bloc PRÉCIS du scénario (comme la cible node de /v1/sends). null = entrée du scénario.
  start_node_id text,
  -- Anti-rebond : délai minimum entre deux déclenchements de CETTE automation pour le MÊME contact.
  -- null = défaut serveur. 0 = aucun garde-fou (un scénario qui repose le tag déclencheur boucle alors).
  cooldown_seconds integer,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Le chemin chaud : à chaque message entrant on cherche les automations ACTIVES d'un tenant pour un type de
-- déclencheur. Index partiel (les automations désactivées ne sont jamais lues sur ce chemin).
create index if not exists automations_tenant_kind_enabled_idx
  on automations (tenant_id, trigger_kind) where enabled;

-- Dernier déclenchement par (automation, contact) : c'est LE garde-fou anti-boucle. Une ligne par couple,
-- écrasée à chaque tir (upsert), donc la table reste petite et bornée par le nombre de contacts touchés.
create table if not exists automation_fires (
  automation_id uuid not null references automations(id) on delete cascade,
  wa_id text not null,
  fired_at timestamptz not null default now(),
  primary key (automation_id, wa_id)
);
