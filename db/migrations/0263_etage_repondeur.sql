-- 0263 : le repondeur d un etage de campagne (plan docs/superpowers/plans/2026-10-30-repondeur-par-etage.md, livraison A,
-- tache 1). Quand l etage dit « le repondeur automatique prend la main » (devenir = 'mba'), il peut dire LEQUEL.
--
-- campaign_etages.repondeur : 'mba' (l agent de Meta) ou 'agent' (un agent IA de l espace). Nul = le repondeur de
--   l espace, le comportement d avant : aucune campagne existante ne change, et aucune reprise de donnees.
-- campaign_etages.repondeur_agent_id : l agent IA, quand repondeur = 'agent'. Cle etrangere en on delete set null :
--   supprimer l agent ne detruit pas l etage (donc la chaine d une campagne peut-etre deja partie), l identifiant
--   repasse a nul et la remise retombe sur le repondeur de l espace.
--
-- POURQUOI C EST POSSIBLE ET NE L ETAIT PAS EN 0145. 0145 a retire agent_id (pose par 0144) parce qu un agent IA
-- n existait pas hors d un scenario (agent_sessions.run_id NOT NULL). Le repondeur (lot 5, 0209) lui a donne un
-- scenario systeme cache : c est par lui que l agent choisi demarre (src/repondeur/demarrer.ts), exactement comme le
-- repondeur de l espace.
--
-- Trois CHECK, nommes pour la relecture en base :
--  - campaign_etages_repondeur_chk : deux valeurs, miroir de REPONDEURS_ETAGE (src/campaign/etages.ts), tenu par
--    tests/migration-0263.test.ts.
--  - campaign_etages_repondeur_devenir_chk : un repondeur seulement quand le repondeur automatique prend la main.
--    🔴 ECRIT « devenir is not distinct from 'mba' » et jamais « devenir = 'mba' » : sur un devenir nul, l egalite
--    vaut NULL, un CHECK qui vaut NULL PASSE, et un etage d avant le reglage aurait pu porter un repondeur.
--  - campaign_etages_repondeur_agent_chk : un identifiant d agent seulement avec repondeur = 'agent' (le motif de 0144),
--    meme piege du NULL, meme ecriture. 🔴 AUCUN CHECK dans l autre sens (« agent exige un identifiant ») : le set null
--    de la suppression d un agent le violerait, et la suppression echouerait en 23514 sur une contrainte de campagne
--    (la lecon de 0144).
--
-- A APPLIQUER AVANT LE UP (migration=avant), et 🔴 BLOQUANTE : la remise de chaque message entrant nommera
-- campaign_etages.repondeur (PgCampaignRepo.repondeurDeLaReponse, chemin chaud). Poussee SEULE et appliquee avant que
-- son code n arrive sur main : deploye avant elle, chaque entrant qui atteint la remise tomberait en 42703, et chaque
-- creation de campagne aussi. L ancien code ne nomme aucune des deux colonnes et y survit : elles naissent nulles, et
-- les CHECK ne portent que sur elles.
--
-- LES VERROUS. Les ajouts de colonne sans defaut sont instantanes (aucune reecriture). Chaque CHECK relit la table
-- (une ligne par etage, quelques milliers) sous ACCESS EXCLUSIVE, et la cle etrangere verrouille agents le temps de
-- sa pose. campaign_etages est lue par chaque run de campagne : lire pg_stat_activity avant (aucune transaction longue
-- sur ces deux tables), et lock_timeout de 5 s, en set local : si une transaction tient une table, l alter echoue au
-- lieu de faire attendre les envois derriere lui, rien n est applique et on relance migrate.
set local lock_timeout = '5s';

alter table campaign_etages add column if not exists repondeur text;
alter table campaign_etages add column if not exists repondeur_agent_id uuid
  constraint campaign_etages_repondeur_agent_fk references agents (id) on delete set null;

alter table campaign_etages drop constraint if exists campaign_etages_repondeur_chk;
alter table campaign_etages add constraint campaign_etages_repondeur_chk
  check (repondeur is null or repondeur in ('mba', 'agent'));

alter table campaign_etages drop constraint if exists campaign_etages_repondeur_devenir_chk;
alter table campaign_etages add constraint campaign_etages_repondeur_devenir_chk
  check (repondeur is null or devenir is not distinct from 'mba');

alter table campaign_etages drop constraint if exists campaign_etages_repondeur_agent_chk;
alter table campaign_etages add constraint campaign_etages_repondeur_agent_chk
  check (repondeur_agent_id is null or repondeur is not distinct from 'agent');
