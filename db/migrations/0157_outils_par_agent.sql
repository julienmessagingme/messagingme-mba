-- 0157 : une ACTION appartient à l'agent, un CONNECTEUR appartient à l'espace.
--
-- 🔴 CE QUE ÇA CHANGE, ET POURQUOI `agent_id` REVIENT APRÈS QUE 0128 L'AIT RETIRÉE. La migration 0127 a fait
-- remonter TOUTE définition au niveau de l'ESPACE, parce que le sujet du moment était le CONSENTEMENT : un
-- connecteur déclaré une fois devait pouvoir servir plusieurs agents et le MBA. C'était juste pour un
-- connecteur, et faux pour une action : « quand le client veut un rendez-vous, pose ce tag » n'est pas une
-- ressource partagée, c'est une décision propre à UN agent. Arbitrage de Julien, 2026-09-18 : `Tools >` est
-- réservé au setup de ce qui pointe vers l'extérieur, les actions en sortent.
--
-- Conséquence directe, et c'est le défaut qu'il a signalé : le nom étant unique par ESPACE, donner « Terminer
-- par une règle d'arrêt » à un second agent rendait « un outil de cet espace porte déjà ce nom ».
--
-- 🔴 MESURÉE EN BASE AVANT D'ÊTRE ÉCRITE, et la mesure a changé la migration. Dans l'espace de production :
-- 7 définitions d'action, **ZÉRO consommateur**, **ZÉRO active**, et 1 seul agent IA, en brouillon. Il n'y a
-- donc AUCUNE définition partagée à dédoubler, AUCUN outil actif dont il faudrait préserver l'extinction,
-- AUCUN lien à réécrire. La reprise de données que le plan annonçait comme la partie la plus dangereuse du
-- lot n'existe pas. Sans cette mesure, on aurait écrit une migration de dédoublement inutile et risquée.
--
-- ⚠️ ELLE NE REPREND DONC RIEN, DÉLIBÉRÉMENT. Les 7 définitions existantes restent à `agent_id is null`,
-- c'est-à-dire exactement ce qu'elles sont aujourd'hui : des définitions d'espace, que l'écran sait déjà
-- brancher sur un agent depuis le correctif du 2026-09-18. Leur inventer rétroactivement un propriétaire
-- choisirait à la place du client un agent qu'il n'a pas désigné.
--
-- ⚠️ ADDITIVE ET PERMISSIVE : `agent_id` est NULLABLE et le CHECK n'exige rien du code déployé, qui ignore
-- cette colonne. C'est la leçon de 0152 appliquée à l'avance : un CHECK strict posé maintenant ferait échouer
-- toute création d'outil pendant la fenêtre où l'on peut encore revenir en arrière. Elle passe AVANT le
-- déploiement.

alter table agent_tools
  add column if not exists agent_id uuid references agents(id) on delete cascade;

-- 🔴 LE `on delete cascade` EST LE BON CHOIX ICI, ET C'ÉTAIT LE MAUVAIS EN 0086. C'est précisément ce que
-- 0127 avait corrigé : supprimer UN agent détruisait des définitions que PLUSIEURS agents partageaient. La
-- propriété a changé de sens depuis : une action à `agent_id` renseigné n'appartient qu'à cet agent-là, donc
-- elle part avec lui, et la laisser derrière créerait un orphelin que rien ne nettoierait jamais. Un
-- connecteur, lui, garde `agent_id is null` et n'est jamais touché par la suppression d'un agent.

-- Seule une ACTION peut appartenir à un agent. Un connecteur (API ou MCP) est déclaré dans `Tools >` et se
-- partage : lui donner un propriétaire le rendrait invisible des autres agents sans que rien ne le dise.
alter table agent_tools drop constraint if exists agent_tools_agent_origin_chk;
alter table agent_tools add constraint agent_tools_agent_origin_chk
  check (agent_id is null or origin = 'mba');

-- 🔴 DEUX INDEX PARTIELS, ET LEUR COUPLE EST LE CONTRAT. `agent_tools_nom_espace_idx` (0127) imposait
-- l'unicité sur (tenant_id, name) SANS condition : c'est lui qui rendait le 409. On le remplace par deux
-- index dont les prédicats sont COMPLÉMENTAIRES et disjoints, ce qui préserve l'unicité dans les deux
-- régimes sans les faire se marcher dessus :
--   - une définition d'ESPACE reste unique par espace, comme avant ;
--   - une action d'AGENT est unique par agent, donc deux agents peuvent chacun avoir leur « terminer ».
-- ⚠️ Un nom peut donc exister à la fois en définition d'espace et en action d'un agent. C'est voulu et sans
-- conséquence : le résolveur lit la ligne, jamais le nom seul, et l'exposition au modèle se fait par agent.
create unique index if not exists agent_tools_nom_espace_uidx
  on agent_tools (tenant_id, name) where agent_id is null;
create unique index if not exists agent_tools_nom_agent_uidx
  on agent_tools (tenant_id, agent_id, name) where agent_id is not null;
drop index if exists agent_tools_nom_espace_idx;

-- Les actions d'un agent, lues à chaque tour : sans lui, l'exposition au modèle balaie toute la table des
-- outils de l'espace. Partiel, pour la même raison que les deux ci-dessus.
create index if not exists agent_tools_par_agent_idx
  on agent_tools (tenant_id, agent_id) where agent_id is not null;
