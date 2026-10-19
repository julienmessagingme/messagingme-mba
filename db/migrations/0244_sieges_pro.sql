-- 0244 : les sieges payants du Pro (spec offres v2, livraison 7, docs/superpowers/specs/2026-10-16-offres-v2-design.md).
--
-- abonnements_offre.sieges : les utilisateurs payes en plus des 3 du Pro (15 euros HT par mois, 150 par an), relus chez
-- Stripe par la route d'achat et par le webhook. La limite d'utilisateurs du Pro devient 3 plus ces sieges, dans droitsDe
-- seulement (src/offres/offres.ts), lue par l'invitation ET par le gel des membres.
--
-- A appliquer AVANT le up : le code neuf lit et ecrit la colonne. L'ancien code y survit : il ne la lit pas, et son
-- insertion la laisse a son defaut. Une colonne NOT NULL a defaut constant ne reecrit pas la table (Postgres 11 et plus).
-- abonnements_offre est lue par offre_de_l_espace sur les chemins chauds : un lock_timeout de 5 s, en set local.
set local lock_timeout = '5s';

alter table abonnements_offre add column if not exists sieges integer not null default 0;
alter table abonnements_offre drop constraint if exists abonnements_offre_sieges_chk;
alter table abonnements_offre add constraint abonnements_offre_sieges_chk check (sieges between 0 and 1000);
