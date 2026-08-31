-- 0091_entretien_bascules.sql — Les moments de bascule de l'entretien de construction, un par un.
-- ADD-only (une colonne nullable avec défaut) : à migrer AVANT le déploiement du code neuf, qui la lit.
--
-- POURQUOI UNE COLONNE ET PAS UNE RÉPONSE DE PLUS. L'état de l'entretien porte déjà `reponses`, une valeur par
-- point de l'ordre du jour. Or les bascules ne sont PAS un point : c'est une LISTE, avec autant d'entrées que
-- le client cite de moments, chacune avec sa propre action et son propre moyen.
--
-- 🔴 Le modèle précédent portait UNE action sur le point `bascules`. Julien, en plein entretien le
-- 2026-08-31, en a donné deux dans la même phrase : « quand le client veut prendre RDV, il faut que l'agent
-- appelle un outil […] quand le client demande où se trouve la concession, il faut lui envoyer un point GPS,
-- j'imagine qu'on peut le faire en envoyant un scénario ? ». Le second écrasait le premier EN SILENCE, et
-- personne ne l'aurait vu avant que l'agent ne reste muet sur l'un des deux cas en production.
--
-- Chaque entrée est { moment, action?, moyen? }. `moment` est la CLÉ d'appariement d'un tour à l'autre, ce qui
-- rend stables les codes de questions engendrées (`bascule_1_action`, `bascule_1_moyen`…) : si la liste se
-- réordonnait, un point noté « posé » désignerait soudain une autre bascule.
alter table agent_setup_conversations
  add column if not exists bascules jsonb not null default '[]'::jsonb;
