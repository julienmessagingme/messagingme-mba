-- 0255_hubspot_modeles.sql : envoyer un modele WhatsApp depuis la carte HubSpot quand la fenetre de 24 h est fermee
-- (sous-lot « relancer » de la reprise humaine, plan mm-hubspot docs/2026-10-26-sous-lot-relancer-modele-plan.md,
-- decisions A a H validees par Julien le 2026-10-26).
--
-- UN INTERRUPTEUR PAR ESPACE, a cote de hubspot_reponse (0251) :
--   hubspot_modeles  envoyer des modeles depuis HubSpot (lu par les routes de la carte)               defaut FAUX
-- Il ouvre une porte d envoi facturee par Meta, donc il est eteint (decision E, comme toute porte d envoi). Il ne
-- vaut que si hubspot_reponse est allume : la route du choix l ecrit a faux quand la reponse s eteint, et la lecture
-- exige les deux.
--
-- ADDITIVE : l ancien code ne nomme pas cette colonne (la lecture des reglages est un select etoile, et une base en
-- retard rend le defaut). Elle passe AVANT le code qui l ecrit.

alter table tenant_settings add column if not exists hubspot_modeles boolean not null default false;
