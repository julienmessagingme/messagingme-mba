-- 0257 : l'offre Business, posee a la main dans /ops (spec docs/superpowers/specs/2026-10-27-offre-business-design.md,
-- plan docs/superpowers/plans/2026-10-27-offre-business-lot-1.md, tache A1).
--
-- POURQUOI. Le Business (349 EUR HT par mois) se vend sur demo et Julien le pose dans /ops, comme l'Entreprise : aucun
-- objet Stripe. Il prend donc la forme de l'Entreprise sur tenants, un drapeau, une limite d'utilisateurs facultative et
-- la date de sortie (la grace de la conservation et la couverture du numero en partent, comme entreprise_quittee_le).
--  - offre_de_l_espace apprend le quatrieme cas : l'Entreprise prime sur le Business, le Business sur un Pro paye.
--  - credits_offerts.complement_business_* : le complement jusqu'a 10 EUR au passage en Business, une fois par espace.
--  - abonnements_numero_id_chk accepte aussi ops_... : la ligne finie qui porte la fin du numero fourni d'une offre
--    posee a la main, qui n'a pas d'abonnement Stripe (la fin d'un Pro, elle, porte l'identifiant du Pro).
--
-- A APPLIQUER AVANT LE UP (migration=avant). L'ancien code y survit : il ignore les colonnes, n'ecrit jamais ops_, et
-- aucun espace n'est en Business avant la route neuve de /ops (l'ancienne refuse le champ). Le CHECK est RELACHE, jamais
-- resserre : tout ce que l'ancien code ecrit passe encore.
--
-- tenants et abonnements_numero sont lues sur les chemins chauds : un lock_timeout de 5 s, en set local.
set local lock_timeout = '5s';

alter table tenants
  add column if not exists offre_business        boolean not null default false,
  add column if not exists business_utilisateurs integer,
  add column if not exists business_quitte_le    timestamptz;
alter table tenants drop constraint if exists tenants_business_utilisateurs_chk;
alter table tenants add constraint tenants_business_utilisateurs_chk
  check (business_utilisateurs is null or business_utilisateurs > 0);

alter table credits_offerts
  add column if not exists complement_business_micro_eur bigint,
  add column if not exists complement_business_le        timestamptz;

-- Le nom est explicite depuis 0214 (constraint abonnements_numero_id_chk, posee dans la creation de la table) : le drop
-- vise bien celle qui existe, et la relecture en base apres migrate le verifie.
alter table abonnements_numero drop constraint if exists abonnements_numero_id_chk;
alter table abonnements_numero add constraint abonnements_numero_id_chk
  check (stripe_subscription_id ~ '^(sub|ops)_[A-Za-z0-9]+$');

create or replace function offre_de_l_espace(espace uuid) returns text
language sql stable as $$
  select case
    when coalesce((select t.offre_entreprise from tenants t where t.id = espace), false) then 'entreprise'
    when coalesce((select t.offre_business from tenants t where t.id = espace), false) then 'business'
    when exists (select 1 from abonnements_offre a where a.tenant_id = espace and a.fini_le is null) then 'pro'
    else 'base'
  end
$$;
