-- 0108_echecs_avance.sql : une panne d'avance de scenario cesse d'etre invisible.
--
-- Lot 4 du plan post-audit, constat de l'audit de scalabilite revalide le 2026-09-02.
--
-- CE QUI SE PASSE AUJOURD'HUI. `processWorkflowAdvance` traite les messages entrants d'un webhook un par un
-- et attrape chaque exception PAR MESSAGE, ecrit un `console.error`, et le job se termine EN SUCCES. Une
-- avance qui echoue apres tous les rejeux Meta est donc perdue : aucun rejeu, aucune DLQ, aucune trace
-- consultable. Le contact reste bloque a son bloc, et personne ne l'apprend jamais.
--
-- L'ISOLATION ELLE-MEME EST BONNE et ne change pas : une erreur sur un contact ne doit pas emporter les
-- autres messages du meme webhook. C'est l'acquittement SILENCIEUX qui ne va pas.
--
-- 🔴 POURQUOI UNE TABLE, alors que le journal des erreurs de livraison refuse explicitement d'en avoir une.
-- Ce refus visait une table qui RECOPIERAIT des lignes existantes (`campaign_recipients` porte deja l'echec
-- d'un envoi de campagne, une seconde copie serait une seconde verite a tenir a jour). Ici, l'echec n'est
-- ecrit NULLE PART : cette table est son seul domicile, pas un doublon.
--
-- ⚠️ NON BLOQUANTE, ET C'EST VOULU. L'ecriture est best-effort chez l'appelant : sans la table, le chemin
-- retombe exactement sur le comportement d'avant (un `console.error`). Un journal d'echec qui ferait echouer
-- le traitement qu'il observe serait une tres mauvaise idee.
--
-- Retention : balayee par le sweeper general (`AVANCE_ECHECS_RETENTION_DAYS`). C'est de l'exploitation, pas
-- une preuve : ca ne se garde pas indefiniment.

create table if not exists workflow_advance_failures (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  -- Le numero, comme dans le journal des erreurs de livraison : sans lui, l'entree ne dit pas A QUI.
  wa_id text not null,
  -- De quel message entrant il s'agissait, pour retrouver le fil. Nullable : on prefere une entree
  -- incomplete a pas d'entree du tout.
  message_id text,
  workflow_id uuid,
  run_id uuid,
  canal text,
  erreur text not null,
  at timestamptz not null default now()
);

-- La lecture est toujours « les plus recents d'un espace » : c'est exactement cet index.
create index if not exists workflow_advance_failures_tenant_at_idx
  on workflow_advance_failures (tenant_id, at desc);
