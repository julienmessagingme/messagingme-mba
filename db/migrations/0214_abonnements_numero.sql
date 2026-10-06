-- 0214 : l'abonnement du numero fourni (lot 3c, livraison B, spec docs/superpowers/specs/2026-10-06-lien-attente-abonnement-design.md).
--
-- Un numero fourni se paie 3,50 EUR HT par mois, en abonnement Stripe (decision de Julien du 2026-10-06), et il n'est
-- attribue qu'une fois le paiement confirme par Stripe. Une ligne par abonnement Stripe, cle = son identifiant : le
-- webhook rejoue un evenement sans rien dupliquer (on conflict), et l'ordre d'arrivee des evenements ne change pas
-- l'etat final.
--
--  - statut : actif (paye), en_retard (un renouvellement a echoue), resilie (l'abonnement est supprime chez Stripe, etat
--    terminal). Rien n'est coupe sur ce statut avant le lot 4.
--  - periode_fin : la fin de la periode payee, lue sur la facture ; nullable (la session de paiement ne la porte pas).
--  - abonnements_numero_un_par_espace : un seul abonnement vivant par espace. Deux paiements ouverts en meme temps
--    (deux onglets) produisent deux abonnements chez Stripe : le second echoue ici en 23505, et Julien est prevenu pour
--    l'annuler.
--
-- Une table NEUVE que seul le code neuf ecrit et lit : avant le up, sans risque pour l'ancien code. Cascade sur
-- l'espace : un espace supprime emporte ses abonnements (Stripe garde les siens).
set local lock_timeout = '5s';

create table if not exists abonnements_numero (
  stripe_subscription_id text primary key,
  tenant_id              uuid not null references tenants (id) on delete cascade,
  livemode               boolean not null,
  statut                 text not null default 'actif',
  periode_fin            timestamptz,
  cree_le                timestamptz not null default now(),
  maj_le                 timestamptz not null default now(),
  constraint abonnements_numero_id_chk check (stripe_subscription_id ~ '^sub_[A-Za-z0-9]+$'),
  constraint abonnements_numero_statut_chk check (statut in ('actif', 'en_retard', 'resilie'))
);

create unique index if not exists abonnements_numero_un_par_espace on abonnements_numero (tenant_id) where statut <> 'resilie';
