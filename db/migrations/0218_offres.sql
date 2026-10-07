-- 0218 : les offres et leurs limites (lot 6, livraison A, spec docs/superpowers/specs/2026-10-07-offres-et-limites-design.md).
--
-- L'offre d'un espace se CALCULE, comme l'etat du numero au lot 4 ; aucun balayage ne l'ecrit. Une seule definition,
-- la fonction offre_de_l_espace, lue par le code (src/offres/offre.pg.ts) ET par les balayages qui en dependent.
--  - abonnements_offre : l'abonnement Pro chez Stripe (livraison B l'ecrit). Vivant tant que Stripe n'en a pas annonce
--    la fin (fini_le vide), relances d'un impaye comprises : c'est Stripe qui decide de la fin.
--  - tenants.offre_entreprise et .entreprise_utilisateurs : l'Entreprise, posee par l'exploitation (/ops), avec sa
--    limite d'utilisateurs (vide = sans limite). Sur tenants et non sur tenant_settings : mesure du 2026-10-07, 7 espaces
--    sur 9 n'ont aucune ligne de reglages.
--  - contacts.ne_entrant : une fiche nee d'un message entrant ne compte jamais dans la limite de contacts. Posee a
--    l'insertion par l'entrant seulement ; une mise a jour ne la touche jamais.
--  - conversations_analysis_status_check : hors_offre, l'etat d'une conversation que l'offre de l'espace n'analyse pas
--    (livraison C), sous le meme nom (lu en base le 2026-10-07).
--  - la reprise : tous les espaces existants passent en Entreprise, sans limite d'utilisateurs (decision de Julien du
--    2026-10-07 : ce sont des espaces de test, rien ne doit les contraindre).
--
-- A appliquer AVANT le up : le code neuf lit la fonction et les colonnes. L'ancien code y survit : il ignore la table,
-- les colonnes et la fonction, et le CHECK elargi accepte tout ce qu'il ecrit.
set local lock_timeout = '5s';

create table if not exists abonnements_offre (
  stripe_subscription_id text primary key,
  tenant_id              uuid not null references tenants (id) on delete cascade,
  periodicite            text not null,
  livemode               boolean not null,
  statut                 text not null default 'actif',
  periode_fin            timestamptz,
  fin_prevue_le          timestamptz,
  fini_le                timestamptz,
  fin_raison             text,
  cree_le                timestamptz not null default now(),
  maj_le                 timestamptz not null default now(),
  constraint abonnements_offre_id_chk check (stripe_subscription_id ~ '^sub_[A-Za-z0-9]+$'),
  constraint abonnements_offre_periodicite_chk check (periodicite in ('mois', 'an')),
  constraint abonnements_offre_statut_chk check (statut in ('actif', 'en_retard', 'resilie')),
  constraint abonnements_offre_fin_raison_chk check (fin_raison is null or (fin_raison in ('resiliation', 'impaye') and fini_le is not null))
);

create unique index if not exists abonnements_offre_un_vivant_par_espace on abonnements_offre (tenant_id) where fini_le is null;

alter table tenants
  add column if not exists offre_entreprise        boolean not null default false,
  add column if not exists entreprise_utilisateurs integer;
alter table tenants drop constraint if exists tenants_entreprise_utilisateurs_chk;
alter table tenants add constraint tenants_entreprise_utilisateurs_chk
  check (entreprise_utilisateurs is null or entreprise_utilisateurs > 0);

alter table contacts add column if not exists ne_entrant boolean not null default false;

alter table conversations drop constraint if exists conversations_analysis_status_check;
alter table conversations add constraint conversations_analysis_status_check
  check (analysis_status in ('pending', 'queued', 'done', 'failed', 'hors_offre'));

create or replace function offre_de_l_espace(espace uuid) returns text
language sql stable as $$
  select case
    when coalesce((select t.offre_entreprise from tenants t where t.id = espace), false) then 'entreprise'
    when exists (select 1 from abonnements_offre a where a.tenant_id = espace and a.fini_le is null) then 'pro'
    else 'base'
  end
$$;

update tenants set offre_entreprise = true where not offre_entreprise;
