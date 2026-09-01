-- 0104_avance_claim.sql : le TOUR d'avance d'un parcours, reserve AVANT les envois.
--
-- Constat A4 de la synthese du 2026-08-31, repris par le contre-audit du 2026-09-01, et documente depuis
-- des semaines dans `executor.ts` : « cette garde protege l'ETAT, pas les effets ».
--
-- Ce qui se passe aujourd'hui. Deux avances peuvent se chevaucher DES MAINTENANT, avec un seul worker :
-- l'API traite un retour RCS pendant que le worker traite un webhook du meme contact. Les deux lisent le run
-- sur le bloc N, calculent chacune leur suite, ENVOIENT toutes les deux, et seule la seconde ecriture est
-- refusee. Le contact recoit donc DEUX messages, et le second est un message qu'il ne devait jamais voir.
--
-- 🔴 Le seul correctif possible est de reserver le tour AVANT les effets, pas apres. D'ou ces deux colonnes.
-- L'ecriture conditionnelle (`setStateSiEncoreSur`) RESTE : elle devient une ceinture, la reservation etant
-- la bretelle. Deux gardes qui se recouvrent valent mieux qu'une seule sur un chemin qui envoie de l'argent.
--
-- Trois pieces, exactement comme le verrou de run de campagne (`src/campaign/run-lock.ts`, migration 0089),
-- parce que ce sont les trois qui font la difference entre un verrou et un drapeau :
--   - un BAIL (`avance_jusqu_a`) : un worker tue en plein traitement ne bloque pas le parcours a vie ;
--   - un JETON (`avance_token`) : le porteur d'un bail perime ne peut pas liberer le verrou de celui qui l'a
--     repris entre-temps ;
--   - et la liberation explicite a la fin, pour ne pas faire attendre le message suivant du contact.
--
-- ⚠️ PAS de drapeau de relance ici, a la difference du verrou de campagne, et c'est un choix. Le perdant
-- d'une avance ne doit RIEN rejouer : son message a ete traite par le gagnant, qui lisait le meme bloc. Un
-- drapeau de relance ferait avancer le parcours deux fois.
--
-- BLOQUANTE : des le deploiement, chaque avance reserve son tour ici.

alter table workflow_runs add column if not exists avance_token uuid;
alter table workflow_runs add column if not exists avance_jusqu_a timestamptz;
