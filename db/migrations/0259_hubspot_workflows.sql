-- 0259_hubspot_workflows.sql : envoyer un modele WhatsApp depuis les workflows HubSpot du client (l'action de workflow
-- « Envoyer un modele WhatsApp », cadrage mm-hubspot docs/2026-10-27-action-workflow-modele-cadrage.md, decisions 1 a 11
-- validees par Julien le 2026-10-27 ; plan du meme jour, lot 1).
--
-- UN INTERRUPTEUR PAR ESPACE, a cote de hubspot_modeles (0255) mais INDEPENDANT de la reponse depuis HubSpot (aucun
-- humain n'est en jeu) :
--   hubspot_workflows  envoyer des modeles depuis les workflows HubSpot (lu par POST /hubspot/workflow/*)   defaut FAUX
-- Il ouvre une porte d envoi facturee par Meta et ouverte a la masse, donc il est eteint (decision 8). La route le relit
-- a chaque envoi, avec l offre.
--
-- ADDITIVE : l ancien code ne nomme pas cette colonne (la lecture des reglages est un select etoile, et une base en
-- retard rend le defaut). Elle passe AVANT le code qui l ecrit.

alter table tenant_settings add column if not exists hubspot_workflows boolean not null default false;
