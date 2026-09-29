-- 0194 : deux evenements de plus dans le journal d'une conversation, pour mesurer le temps de reponse et le temps
-- de resolution de l'equipe (Quantitatif > Performance, cadrage du 2026-09-29).
--
--  - escaladee : un robot (un scenario, un agent IA) passe la main a l'equipe, drapeau d'escalade pose. Le passage
--    de l'agent de Meta a deja le sien (passee_par_mba, 0192) : il n'est pas double.
--  - rendue_scenario : l'equipe rend le fil a un scenario (app_human vers app_workflow).
-- Ecrits par PgInboxStore.setControlOwner, dans la MEME requete que la bascule, et seulement si le detenteur a
-- vraiment change (regles dans src/inbox/evenements.ts).
--
-- 🔴 ELLE RELACHE, DONC AVANT LE UP. Le code neuf ecrit ces deux types dans la requete de la bascule elle-meme :
-- deploye avant elle, chaque escalade d'un scenario ou d'un agent IA, et chaque reprise d'un fil par un scenario,
-- echoueraient en 23514, bascule comprise (une seule requete). L'ancien code n'ecrit que les douze types d'hier,
-- que le CHECK elargi accepte toujours : il y survit.
--
-- 🔴 LE NOM EST CELUI QUE 0192 A POSE, nomme dans son create table (conversation_evenements_type_check), pas un
-- nom devine. Un nom a cote laisserait l'ancien CHECK en place ET ajouterait le neuf : les deux types seraient
-- refuses par le premier, en silence jusqu'a la premiere escalade. Le drop et l'add sont dans la meme transaction :
-- aucune fenetre sans CHECK.
--
-- ⚠️ PAS DE REPRISE, et c'est delibere : rien ne datait ces bascules avant elle, et une date inventee fausserait
-- les chiffres qu'on veut montrer. Les indicateurs demarrent a son APPLICATION, que l'ecran annonce (« mesure
-- depuis le ... ») en lisant sa ligne de schema_migrations (src/stats/performance.pg.ts, MIGRATION_DES_DEMANDES).
-- Renommer ce fichier apres son application ferait perdre cette date : un test compare les deux noms.
--
-- ⚠️ LE VERROU. add constraint pose un ACCESS EXCLUSIVE sur conversation_evenements le temps de relire ses lignes
-- (une table jeune, quelques milliers de lignes) : les ecritures de l'Inbox, qui y inserent, attendent ce temps-la.
-- Lire pg_stat_activity avant (aucune transaction longue ouverte sur la table). Et lock_timeout : si une transaction
-- tient la table malgre tout, l'alter echoue au bout de 5 s au lieu de faire attendre derriere lui l'upsert de chaque
-- message entrant ; on relance migrate, rien n'a ete applique.
set local lock_timeout = '5s';
alter table conversation_evenements drop constraint if exists conversation_evenements_type_check;
alter table conversation_evenements add constraint conversation_evenements_type_check check (type in (
  'assignee', 'desassignee', 'prise_mba', 'rendue_mba', 'passee_par_mba',
  'traitee', 'non_traitee', 'archivee', 'desarchivee', 'signalee', 'designalee', 'rouverte',
  'escaladee', 'rendue_scenario'
));
