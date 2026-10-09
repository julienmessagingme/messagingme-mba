-- 0225 : le statut de livraison d'un message seul (lot 13, domaine 1, livraison B ; spec
-- docs/superpowers/specs/2026-10-08-api-complete-design.md, section 3).
--
-- Jusqu'ici seul l'envoi d'une campagne gardait son statut (campaign_recipients.delivery_status) ; un message seul
-- n'avait que accuse_le (le premier accuse) et, en echec, une ligne echecs_messages. GET /v1/messages/{id} rend
-- desormais le statut que Meta a annonce, ecrit par le traitement des accuses sans jamais reculer.
--
--  - statut : sent, delivered, read ou failed ; nul tant qu'aucun accuse n'est arrive (et pour un message recu).
--  - statut_le : l'instant de l'accuse qui l'a pose (celui de Meta, sinon l'heure de reception).
--
-- ORDRE : deux colonnes nullables SANS defaut (aucune reecriture de la table). Le code neuf les ECRIT (worker des
-- accuses) et les LIT (API) : la migration passe AVANT le up de l'API et des deux workers. L'ancien code les ignore.
--
-- Le CHECK est pose NOT VALID : la colonne est neuve et nulle partout, rien a balayer, et la migration ne depend plus
-- de la taille de la table (424 lignes mesurees en production le 2026-10-08). Les ecritures neuves sont controlees.
set local lock_timeout = '5s';

alter table conversation_messages add column if not exists statut text;
alter table conversation_messages add column if not exists statut_le timestamptz;

alter table conversation_messages drop constraint if exists conversation_messages_statut_chk;
alter table conversation_messages add constraint conversation_messages_statut_chk
  check (statut is null or statut in ('sent', 'delivered', 'read', 'failed')) not valid;
