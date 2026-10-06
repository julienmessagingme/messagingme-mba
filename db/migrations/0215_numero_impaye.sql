-- 0215 : ce que devient un numero fourni dont l'abonnement tombe (lot 4, livraison A, spec
-- docs/superpowers/specs/2026-10-06-numero-impaye-design.md).
--
-- L'etat de l'abonnement se CALCULE sur des dates (src/stripe/etat-abonnement.ts) ; aucun balayage n'ecrit de statut.
--  - premier_echec_le : le premier echec de paiement d'une serie (pose par invoice.payment_failed s'il ne l'est pas
--    deja, efface par invoice.paid). Sept jours apres, les envois du numero sont coupes.
--  - fin_prevue_le : la resiliation programmee (customer.subscription.updated) ; les envois restent ouverts.
--  - fini_le : la fin effective (customer.subscription.deleted) ; les envois sont coupes, le numero garde 7 jours.
--  - libere_le : la liberation faite (livraison B : delie, resilie chez DIDWW).
--  - abonnements_numero_avis : chaque alerte et chaque e-mail ne part qu'une fois par abonnement, sur le modele de
--    repondeur_alertes_credit (0209).
--  - campaigns_pause_reason_check : le motif numero_suspendu, sous le meme nom (une campagne s'arrete sur un numero
--    suspendu comme sur un numero delie, et reprend au paiement).
--  - la reprise : les abonnements deja resilies sont dates de leur derniere mise a jour (l'espace de l'essai du
--    2026-10-06, resilie a 15 h 14 UTC, est donc suspendu au deploiement : c'est l'essai reel du lot 4).
--
-- A appliquer AVANT le up : le webhook neuf ecrit les colonnes. L'ancien code y survit : il ignore les colonnes et la
-- table, et le CHECK elargi accepte tout ce qu'il ecrit.
set local lock_timeout = '5s';

alter table abonnements_numero
  add column if not exists premier_echec_le timestamptz,
  add column if not exists fin_prevue_le    timestamptz,
  add column if not exists fini_le          timestamptz,
  add column if not exists libere_le        timestamptz;

create table if not exists abonnements_numero_avis (
  stripe_subscription_id text not null references abonnements_numero (stripe_subscription_id) on delete cascade,
  avis                   text not null,
  envoye_le              timestamptz not null default now(),
  primary key (stripe_subscription_id, avis),
  constraint abonnements_numero_avis_chk check (avis in (
    'suspension_telegram', 'suspension_mail', 'rappel_liberation_mail', 'liberation_mail', 'liberation_telegram'
  ))
);

alter table campaigns drop constraint if exists campaigns_pause_reason_check;
alter table campaigns add constraint campaigns_pause_reason_check
  check (pause_reason in ('debit', 'qualite', 'hors_horaires', 'numero_delie', 'numero_suspendu'));

update abonnements_numero set fini_le = maj_le where statut = 'resilie' and fini_le is null;
