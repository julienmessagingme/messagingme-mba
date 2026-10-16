-- Les offres, deuxième version (spec docs/superpowers/specs/2026-10-16-offres-v2-design.md, livraison 1) : deux réglages
-- d'Entreprise posés par l'exploitation (/ops), à côté de la limite d'utilisateurs.
--  - tenants.entreprise_contacts : les contacts créés, réglés sur devis ; null = le défaut de l'Entreprise (sans limite).
--  - tenants.entreprise_commission_pct : la commission sur le crédit IA, négociée ; un entier de 0 à 100 ; null = 10.
-- Additive : l'ancien code ne lit pas ces colonnes, elle passe AVANT le up.
-- La table tenants est lue a chaque requete (l'offre, l'authentification) : un verrou qui attend mettrait tous les lecteurs en
-- file derriere lui. Au-dela de 5 s, la migration echoue et se rejoue (tout est idempotent).
set local lock_timeout = '5s';

alter table tenants
  add column if not exists entreprise_contacts integer,
  add column if not exists entreprise_commission_pct integer;

alter table tenants drop constraint if exists tenants_entreprise_contacts_chk;
alter table tenants add constraint tenants_entreprise_contacts_chk
  check (entreprise_contacts is null or entreprise_contacts > 0);

alter table tenants drop constraint if exists tenants_entreprise_commission_pct_chk;
alter table tenants add constraint tenants_entreprise_commission_pct_chk
  check (entreprise_commission_pct is null or entreprise_commission_pct between 0 and 100);
