-- migrate: no-transaction
--
-- 0113_agent_tour_en_vol_index.sql : l index du balayage suit le predicat de sa requete.
--
-- 🔴 CE QUI S EST PASSE, ET LA LECON VAUT PLUS QUE LES DEUX INSTRUCTIONS. La 0112 a pose un index PARTIEL
-- `where status = 'en_cours' and tour_commence_le is not null`, taille sur la requete du balayage telle
-- qu elle etait ce jour-la. Le 2026-09-03, le correctif de la transition terminale a RETIRE la condition de
-- statut de cette requete, pour qu elle ramasse aussi les sessions deja closes dont la sortie est restee due
-- (`reclamerToursBloques`, src/agent/session-store.pg.ts). Le planificateur ne peut plus prouver que le
-- predicat de la requete IMPLIQUE celui de l index : il l ecarte, en silence, et le balayage lit toute la
-- table, chaque minute.
--
-- **Un index partiel est un CONTRAT avec une requete precise.** Elargir le domaine d une requete la fait
-- sortir de ce contrat, et rien ne le signale : ni le compilateur, ni les tests, ni une erreur au demarrage.
-- Le seul symptome est un plan d execution qui change. C est la meme famille que le defaut corrige le meme
-- jour dans le code (elargir le domaine d une reparation sans elargir ce qu elle transporte).
--
-- ⚠️ NON BLOQUANTE, et il faut le dire honnetement. Aucun code n ecrit ni ne lit cet index : sans elle, le
-- balayage rend exactement les memes lignes, un peu plus lentement. La table `agent_sessions` compte
-- aujourd hui une poignee de lignes, donc Postgres prefererait de toute facon un balayage sequentiel. On la
-- pose a froid, pour la meme raison que la 0096 : construire un index sur une grosse table sous charge est
-- un geste qu on ne veut pas avoir a faire le jour ou ca compte.
--
-- 🔴 HORS TRANSACTION (`CREATE INDEX CONCURRENTLY` est interdit dans un bloc de transaction), donc SANS
-- FILET : un echec a mi-parcours n annule rien et la migration est rejouee depuis le debut. Les deux
-- instructions sont idempotentes.

-- Le nouvel index couvre le predicat REEL : une marque posee, quel que soit le statut. Il reste petit par
-- construction, `tour_commence_le` etant effacee des que le tour est entierement deroule (`finirLeTour` pour
-- les sessions qui restent vivantes, `sortieAppliquee` pour celles dont la sortie a ete appliquee).
create index concurrently if not exists agent_sessions_tour_en_vol_v2_idx
  on agent_sessions (tour_commence_le)
  where tour_commence_le is not null;

-- L ancien n a plus aucun usage : c etait le seul index sur cette colonne, et son unique requete est celle
-- qu on vient de couvrir. Le garder couterait une ecriture de plus a chaque `prendreLeTour`, qui est le
-- chemin chaud du bloc agent, pour ne servir personne.
drop index concurrently if exists agent_sessions_tour_en_vol_idx;
