-- LE FIL DE L'ASSISTANT DU META BUSINESS AGENT.
--
-- 🔴 UN PAR ESPACE, PAS UN PAR UTILISATEUR (décision de Julien du 2026-09-14 : « un fil continu par
-- surface »). Le MBA est unique dans un espace : sa conversation l'est aussi, et les admins la partagent.
-- C'est ce qui permet à l'un de reprendre ce que l'autre a commencé, et c'est pourquoi chaque message porte
-- son auteur (`auteurs`, même forme qu'`agent_setup_conversations` depuis 0147).
--
-- ⚠️ `tenant_id` EST LA CLÉ PRIMAIRE, et ce n'est pas un raccourci : il n'y a rien d'autre à quoi
-- s'accrocher. Un `id` autonome autoriserait deux fils pour un même espace, c'est-à-dire exactement ce
-- qu'on ne veut pas, et il faudrait alors un index unique pour le réinterdire.
create table if not exists mba_assistant_conversations (
  tenant_id  uuid primary key references tenants(id) on delete cascade,
  messages   jsonb not null default '[]'::jsonb,
  auteurs    jsonb not null default '[]'::jsonb,
  -- Ce que le client a répondu aux points de l'ordre du jour, et ceux qu'on lui a déjà posés : c'est ce qui
  -- rend la séquence des questions DÉTERMINISTE, tenue par le serveur et non par le modèle.
  reponses   jsonb not null default '[]'::jsonb,
  poses      jsonb not null default '[]'::jsonb,
  updated_at timestamptz not null default now()
);
