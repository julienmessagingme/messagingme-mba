-- migrate: no-transaction
-- 0115_parcours_actif_index.sql : l'index qui sert « le parcours ACTIF de ce contact ».
--
-- 🔴 POURQUOI MAINTENANT. Depuis le lot du 2026-09-07, lancer un scenario CLOT celui en cours
-- (`closeActiveByWaId`, appelee depuis `runFrom`, le passage commun des quatre chemins de demarrage). Sa
-- clause est `tenant_id = $1 and wa_id = $2 and status in ('waiting','sleeping')`, et MESURE sur la base de
-- production : AUCUN index existant ne la sert.
--   - `workflow_runs_waiting_idx (tenant_id, wa_id) where status = 'waiting'` ne couvre pas `sleeping` ;
--   - `workflow_runs_sleeping_idx (resume_at) where status = 'sleeping'` est cle sur la date, donc inutile
--     pour une recherche par (espace, numero).
-- C'est le cas d'ecole que le CLAUDE.md decrit : un index PARTIEL est un contrat avec une requete precise,
-- et en sortir ne produit pas une erreur, seulement un plan d'execution different.
--
-- 🔴 CE QUI REND LA CHOSE URGENTE, c'est le VOLUME D'APPELS, pas la requete elle-meme. Elle existait deja,
-- mais n'etait appelee que par un lancement manuel depuis l'Inbox, c'est-a-dire quelques fois par jour.
-- Elle est desormais appelee UNE FOIS PAR DESTINATAIRE de campagne scenario. Sans cet index, une campagne a
-- 5 000 destinataires ferait 5 000 balayages sequentiels de `workflow_runs`.
--
-- ⚠️ La mesure du plan sur la production ne prouve rien A ELLE SEULE aujourd'hui : la table y contient 43
-- lignes, et Postgres choisit legitimement un `Seq Scan` a cette taille. Ce qui decide, c'est qu'aucun index
-- ne PEUT servir la clause, ce qui se lit dans `pg_indexes` et ne depend pas du volume actuel.
--
-- ADDITIVE : aucune colonne, aucune donnee touchee, aucun code ne cesse de fonctionner sans elle (elle ne
-- change que le plan). L'ordre par rapport au deploiement est donc libre.
--
-- ⚠️ HORS TRANSACTION (`CREATE INDEX CONCURRENTLY`) : ne pose pas de verrou d'ecriture sur la table, qui est
-- sur le chemin chaud des messages entrants. Le prix est qu'il n'y a AUCUN filet : un echec a mi-parcours
-- laisse un index `invalid` et la migration est rejouee depuis le debut. D'ou le `if not exists`, qui rend
-- l'instruction idempotente.
--
-- 🔴 MAIS `if not exists` NE REPARE PAS UN INDEX INVALIDE, IL LE SAUTE. Un echec en cours de construction
-- laisse une ligne dans `pg_index` avec `indisvalid = false` : la migration rejouee dira « deja la » et
-- s'annoncera passee, avec un index que le planificateur n'utilisera jamais. La verification apres
-- deploiement n'est donc pas facultative :
--   select indisvalid from pg_index where indexrelid = 'workflow_runs_actif_idx'::regclass;
-- `false` -> `drop index concurrently workflow_runs_actif_idx;` puis rejouer.

create index concurrently if not exists workflow_runs_actif_idx
  on workflow_runs (tenant_id, wa_id)
  where status in ('waiting', 'sleeping');

-- ⚠️ `workflow_runs_waiting_idx` N'EST PAS RETIRE ICI, et c'est deliberé. Le nouvel index le rend
-- probablement redondant (une requete `status = 'waiting'` implique `status in ('waiting','sleeping')`,
-- donc Postgres peut se servir du nouveau), mais « probablement » ne suffit pas pour retirer l'index qui
-- sert `findWaitingByWaId`, lu sur le chemin chaud de CHAQUE message entrant. La question est notee dans
-- `todo.md` : elle se tranchera sur un `explain` mesure APRES que cet index-ci existe, pas avant.
