-- 0122_campagne_heures_ouvrees.sql : une campagne qui n'envoie QUE pendant les heures ouvrees.
--
-- Demande de Julien du 2026-09-08 : « que ca soit maintenant ou plus tard, peut-on rajouter un toggle
-- envoyer uniquement pendant les business hours ». Deux situations, une seule mecanique :
--   - lancee a 23 h avec le toggle : elle ne part pas, elle est repoussee a la prochaine ouverture ;
--   - pas finie a la fermeture : elle s'arrete la et REPREND au creneau suivant.
--
-- 🔴 AUCUNE NOUVELLE MACHINERIE DE REPRISE : celle de la migration 0103 fait deja exactement ca. Une
-- campagne interrompue se met `paused` avec un `paused_until`, et un balayage la reprend a l'echeance. On
-- ajoute donc un TROISIEME motif de pause, on ne reecrit pas un second mecanisme a cote qui aurait diverge.
--
-- Trois changements, et le troisieme est celui qu'on oublie :
--   1. la colonne qui porte le choix du client ;
--   2. le CHECK de `pause_reason`, qui n'accepte que 'debit' et 'qualite' depuis 0103 : sans lui, la mise en
--      pause echouerait a l'ecriture, en pleine campagne ;
--   3. 🔴 L'INDEX PARTIEL DE REPRISE, qui est un CONTRAT AVEC UNE REQUETE PRECISE. Il ne couvre aujourd'hui
--      que `pause_reason = 'debit'`. Elargir la requete sans elargir l'index ne produit AUCUNE erreur : juste
--      un balayage qui parcourt la table des campagnes toutes les minutes. Le predicat de l'index et le WHERE
--      de `reprendreCampagnesDues` sont ecrits pour se correspondre exactement.
--
-- ⚠️ 'qualite' reste DEHORS des deux, et c'est delibere : cette pause-la n'a jamais d'echeance et ne se
-- reprend jamais toute seule (Meta juge le numero, pas la cadence).
--
-- BLOQUANTE : des le deploiement, le moteur lit `business_hours_only` et ecrit `pause_reason = 'hors_horaires'`.

alter table campaigns add column if not exists business_hours_only boolean not null default false;

-- Le CHECK de 0103 a ete cree en ligne, donc nomme automatiquement `campaigns_pause_reason_check`.
alter table campaigns drop constraint if exists campaigns_pause_reason_check;
alter table campaigns add constraint campaigns_pause_reason_check
  check (pause_reason in ('debit', 'qualite', 'hors_horaires'));

-- Meme index, predicat elargi au nouveau motif. `drop` puis `create` plutot qu'un second index : deux index
-- sur la meme colonne se seraient partages les lignes, et le planificateur en aurait choisi un des deux.
drop index if exists campaigns_reprise_idx;
create index if not exists campaigns_reprise_idx
  on campaigns (paused_until)
  where status = 'paused' and pause_reason in ('debit', 'hors_horaires') and paused_until is not null;
