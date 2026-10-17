-- 0241_quotas_modeles_reponses.sql : le quota quotidien d'envois de l'API se scinde en deux familles (spec
-- docs/superpowers/specs/2026-10-16-offres-v2-design.md, livraison 2).
--
-- POURQUOI. La famille des envois melait les modeles (destinataires de /v1/sends, send_template_to_contact) et les
-- reponses (messages libres dans la fenetre de 24 h) : un envoi de modeles qui epuisait le quota bloquait les reponses
-- aux clients du client. La Free a desormais 500 modeles par jour, mais ses reponses ne descendent jamais sous 2 000.
--
-- DEUX COLONNES NULLABLES, SANS DEFAUT, comme 0181 et 0208 : null = le defaut de l'offre, sinon de la configuration.
-- UN CHECK > 0 PAR COLONNE, pose AVEC la colonne : if not exists saute le tout quand la colonne existe, la migration se
-- rejoue. Retirer un reglage, c'est ecrire null.
--
-- api_quota_envois_jour (0208) n'est plus lue par le code neuf. Aucun espace n'y avait de valeur (sonde en lecture seule
-- du 2026-10-17) : rien a recopier. Elle se retire APRES le deploiement (l'ancien code la nomme), par une migration
-- suivante.
--
-- ADDITIVE, ET ELLE PASSE AVANT LE DEPLOIEMENT DU CODE QUI LA LIT : le code neuf la nomme dans la lecture des reglages
-- d'un espace ; sans elle, cette lecture echoue en 42703 (le plafond d'appels retombe aux defauts, les quotas laissent
-- passer, la route d'exploitation rend 500). L'ancien code ne la connait pas.
--
-- tenant_settings est lue sur les chemins chauds : un lock_timeout de 5 s. En set local, comme 0240 : borne a la
-- transaction de la migration, il ne peut pas rester sur une connexion du pooler si elle echoue.

set local lock_timeout = '5s';

alter table tenant_settings add column if not exists api_quota_modeles_jour integer
  constraint tenant_settings_api_quota_modeles_jour_positif check (api_quota_modeles_jour > 0);

alter table tenant_settings add column if not exists api_quota_reponses_jour integer
  constraint tenant_settings_api_quota_reponses_jour_positif check (api_quota_reponses_jour > 0);
