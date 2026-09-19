-- 0160 : trois colonnes pour l'Inbox (plan docs/superpowers/plans/2026-09-19-inbox-traite-medias-prise.md).
--
-- Une seule migration pour les trois lots du plan, délibérément : elles AJOUTENT toutes les trois une colonne
-- que le code écrit ou nomme, donc elles passent au même moment (AVANT le déploiement), et un seul numéro
-- évite de réserver trois places pendant qu'une autre session travaille dans le même dépôt.
--
-- 1) `conversations.traitee_le` : la conversation a été marquée « Traité » à la main.
--
-- 🔴 DISTINCTE D'`archived_at`, et c'est l'arbitrage de Julien du 2026-09-19. « Traité » sort la conversation
-- du dossier « À traiter » mais la laisse dans « Tout » ; « Archivé » continue de tout cacher. Un message du
-- CONTACT efface les deux, dans la même écriture que celle qui enregistre ce message
-- (`upsertConversationByWaId`) : deux écritures laisseraient une fenêtre où un message neuf dort dans un
-- dossier que personne ne regarde.
--
-- Nullable SANS défaut : null = pas traitée, c'est-à-dire l'état de TOUTES les conversations existantes, donc
-- aucune ne change de dossier au déploiement. AUCUN index : le dossier est filtré par espace, et rien à cette
-- échelle ne le justifie. Un index partiel est un contrat avec une requête ; on le posera avec elle le jour où
-- un plan d'exécution le demandera.
alter table conversations add column if not exists traitee_le timestamptz;

-- 2) `conversation_messages.media_nom` : le NOM de fichier d'un document reçu, tel que WhatsApp l'annonce.
--
-- Sans lui, un PDF reçu s'affiche « [document] » et se télécharge sous un nom inventé : l'opérateur ne sait
-- pas s'il ouvre une facture ou un bon de commande. Il n'existe QUE dans le corps du webhook, comme
-- l'identifiant du média (0125) : un nom non capté à l'insertion est perdu, aucun chemin en aval ne le
-- retrouve. Nullable, sans défaut : les images, vidéos et vocaux n'en ont pas.
alter table conversation_messages add column if not exists media_nom text;

-- 3) `tenant_settings.agents_peuvent_prendre` : un agent (rôle `agent`) peut-il s'affecter une conversation
-- du pot commun ?
--
-- 🔴 PRENDRE, JAMAIS RÉAFFECTER (arbitrage de Julien, 2026-09-19) : « un agent ne peut pas réaffecter de
-- conversations, ni les siennes, ni celles du pot commun, en revanche il peut prendre parmi celles du pot
-- commun ». La distribution reste le geste de l'encadrement.
--
-- `false` par défaut : aucun agent ne peut le faire aujourd'hui, donc cette migration ne change RIEN pour
-- personne tant qu'un admin ou un manager ne l'a pas activé.
alter table tenant_settings add column if not exists agents_peuvent_prendre boolean not null default false;
