-- 0232 : les actions de l agent IA (plan docs/superpowers/plans/2026-10-13-actions-agent.md ; spec
-- docs/superpowers/specs/2026-10-13-actions-agent-design.md). Un outil de l agent, declencher_action, fait partir un
-- webhook agent.action vers l application du client, une trace dans la frise et une automation.
--
--  - agent_actions : ce qui est parti. Une ligne par action declenchee, avec les champs recueillis (des donnees du
--    contact). La contrainte agent_actions_une_par_jour tient la regle de Julien (une fois par jour, par contact et par
--    action) : le handler reserve sa ligne en insert ... on conflict do nothing, et l identifiant du webhook en derive,
--    donc un tour rejoue n envoie rien deux fois. jour : la date dans le fuseau de l espace, calculee par le code.
--    Tout s efface en cascade avec l espace, l outil, l agent ou la conversation : la purge d un contact, qui efface
--    sa conversation, emporte ses actions.
--  - conversation_evenements_type_check : les dix-huit types de 0217, plus action_agent (une action est partie ; la
--    cause nomme l agent et l action).
--
-- ELLE AJOUTE ET RELACHE, DONC AVANT LE UP de l API et des deux workers : le code neuf ecrit la table et le type.
-- L ancien code n ecrit ni l une ni l autre, il y survit.
set local lock_timeout = '5s';

create table if not exists agent_actions (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references tenants(id) on delete cascade,
  tool_id         uuid not null references agent_tools(id) on delete cascade,
  agent_id        uuid not null references agents(id) on delete cascade,
  conversation_id uuid not null references conversations(id) on delete cascade,
  wa_id           text not null,
  jour            date not null,
  champs          jsonb not null default '{}'::jsonb,
  at              timestamptz not null default now(),
  constraint agent_actions_une_par_jour unique (tool_id, wa_id, jour)
);

create index if not exists agent_actions_conversation_idx on agent_actions (tenant_id, conversation_id, at desc);

alter table conversation_evenements drop constraint if exists conversation_evenements_type_check;
alter table conversation_evenements add constraint conversation_evenements_type_check check (type in (
  'assignee', 'desassignee', 'prise_mba', 'rendue_mba', 'passee_par_mba',
  'traitee', 'non_traitee', 'archivee', 'desarchivee', 'signalee', 'designalee', 'rouverte',
  'escaladee', 'rendue_scenario', 'sortie_agent', 'urgente', 'urgence_levee', 'mba_indisponible', 'action_agent'
));
