-- 0071 : modération légère — repérer les conversations injurieuses, et bloquer un contact.
--
-- DEUX choses distinctes, volontairement séparées :
--
--   conversation_analysis.abusive -> un CONSTAT, posé par l'analyse existante (LLM). Il ne déclenche rien.
--   contacts.blocked_at           -> une DÉCISION humaine, prise depuis l'écran, qui a des effets.
--
-- Les mélanger reviendrait à laisser un modèle bloquer des clients tout seul, ce qui n'est ni voulu ni
-- défendable devant le client concerné.
--
-- ⚠️ Le constat arrive TARD : l'analyse tourne 15 min après le dernier message d'une conversation devenue
-- inactive (`CONVERSATION_ANALYSIS_STALE_MS`), balayée toutes les 5 min. C'est un rapport à traiter, pas une
-- alerte temps réel. Assumé explicitement par Julien le 2026-08-21.
--
-- `blocked_at` porte la DATE et non un booléen : « depuis quand » est la première question qu'on se pose en
-- retrouvant un contact bloqué, et un booléen l'aurait perdue.
--
-- Migration ADDITIVE : à appliquer AVANT le déploiement du code.
alter table conversation_analysis
  add column if not exists abusive boolean not null default false;

alter table contacts
  add column if not exists blocked_at timestamptz,
  add column if not exists blocked_by uuid references users (id) on delete set null;

-- L'écran « contacts bloqués » des paramètres est la SEULE porte de sortie d'un blocage : sans lui, un
-- contact bloqué est introuvable, donc perdu. Il doit donc être servi par un index dès le premier jour.
-- Partiel : les contacts bloqués sont une poignée, les autres n'ont rien à faire dans cet index.
create index if not exists contacts_blocked_idx
  on contacts (tenant_id, blocked_at desc)
  where blocked_at is not null;

-- Retrouver les conversations signalées, par tenant et par date. Partiel pour la même raison.
create index if not exists conversation_analysis_abusive_idx
  on conversation_analysis (tenant_id, created_at desc)
  where abusive;
