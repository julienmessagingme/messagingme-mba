-- 0208_quotas_api.sql : les quotas QUOTIDIENS de l'API publique par espace, reglables espace par espace (decision de
-- Julien du 2026-10-04, docs/ARCHITECTURE-CIBLE.md § 13.1).
--
-- POURQUOI. Le plafond d'appels (0181) protege l'infrastructure, pas les destinataires : sous lui, une boucle chez un
-- integrateur pouvait viser 50 000 destinataires par heure. Le quota compte le TRAVAIL d'un jour civil de Paris, en
-- deux familles : les envois (destinataires de /v1/sends et messages libres) et les fiches ecrites (/v1/contacts).
-- Defauts de la configuration : 2 000 envois et 20 000 fiches par jour (API_QUOTA_ENVOIS_JOUR, API_QUOTA_FICHES_JOUR).
--
-- DEUX COLONNES NULLABLES, SANS DEFAUT, comme 0181 : null = le defaut de la configuration. Un defaut ecrit en base
-- figerait la valeur du jour dans chaque ligne.
--
-- UN CHECK > 0 PAR COLONNE, comme 0181 : 0 voudrait dire « aucun quota » dans la configuration, et un reglage d'espace
-- ne doit pas pouvoir ouvrir l'envoi en grand par une faute de frappe. Retirer un reglage, c'est ecrire null.
-- Contraintes posees AVEC la colonne : if not exists saute le tout quand la colonne existe, la migration se rejoue.
--
-- ADDITIVE, ET ELLE PASSE AVANT LE DEPLOIEMENT DU CODE QUI LA LIT. Le code neuf la NOMME dans la lecture des reglages
-- d'un espace, la meme requete que le plafond d'appels (0181) : sans elle, CETTE lecture echoue en 42703 pour tout
-- l'appel, donc le plafond d'appels propre a un espace retombe aussi au defaut (60 et 1 000), les quotas laissent
-- passer (reglage inconnu), et la route d'exploitation rend 500. L'ancien code ne la connait pas.
--
-- tenant_settings est lue sur les chemins chauds : un lock_timeout de 5 s, comme 0196, pour qu'une transaction longue
-- qui la tiendrait fasse echouer la migration au lieu de bloquer toutes les lectures derriere elle.

set lock_timeout = '5s';

alter table tenant_settings add column if not exists api_quota_envois_jour integer
  constraint tenant_settings_api_quota_envois_jour_positif check (api_quota_envois_jour > 0);

alter table tenant_settings add column if not exists api_quota_fiches_jour integer
  constraint tenant_settings_api_quota_fiches_jour_positif check (api_quota_fiches_jour > 0);

reset lock_timeout;
