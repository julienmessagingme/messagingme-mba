-- 0121_analyse_urgence_satisfaction.sql : deux mesures neuves dans l'analyse de conversation.
--
-- Demande de Julien du 2026-09-08 (lot F de la refonte des menus) : la page de synthese du Performance Lab
-- doit situer les conversations sur deux axes, « ou en est le client » et « a quel point ca presse ».
-- L'analyse rendait deja `sentiment` (trois valeurs) et rien du tout sur l'urgence : trop grossier pour un
-- nuage de points, et muet sur la seule question qui fait agir tout de suite.
--
-- Echelle de 0 a 10 en `smallint`, pas un flottant de 0 a 1 : c'est une note qu'un modele rend de facon
-- stable et qu'un humain lit sans conversion, et le nuage n'a pas besoin de plus de resolution.
--
-- 🔴 NULLABLES, ET `null` DOIT RESTER DISTINCT DE `0`. Les analyses d'AVANT cette migration n'ont aucune
-- mesure ; les compter comme zero placerait tout l'historique dans le coin « client furieux, urgence
-- nulle » et ferait mentir la moyenne. Le nuage IGNORE les lignes sans mesure et DIT combien il en a
-- ignorees. C'est aussi pourquoi il n'y a ni `default 0` ni remplissage : reanalyser les conversations
-- deja lues par des humains pour gagner quatorze points sur un nuage qui se remplira seul serait un
-- mauvais echange (decision de Julien, meme jour).
--
-- Le CHECK borne l'echelle EN BASE, en plus du schema Zod qui la borne a l'ecriture. Il est porte par le
-- `add column` : quand la colonne existe deja, l'instruction entiere est sautee, donc rejouer la migration
-- ne tente pas de reposer une contrainte de meme nom.
--
-- 🔴 BLOQUANTE : des son deploiement, chaque analyse ecrit ces deux colonnes.

alter table conversation_analysis add column if not exists satisfaction smallint
  check (satisfaction between 0 and 10);
alter table conversation_analysis add column if not exists urgence smallint
  check (urgence between 0 and 10);
