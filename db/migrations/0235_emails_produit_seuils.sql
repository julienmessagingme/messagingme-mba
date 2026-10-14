-- 0235 : les seuils franchis des limites du Free (lot 7, livraison B ; plan docs/superpowers/plans/2026-10-14-emails-produit.md).
--
--  - emails_produit_seuils : pour un espace et un seuil (contacts a 80 %, a 100 %), s il est atteint, et combien de fois
--    il l a ete. L alerte des contacts part UNE FOIS PAR FRANCHISSEMENT (decision de Julien du 2026-10-14) : un espace
--    qui repasse sous le seuil puis le refranchit est prevenu de nouveau, un espace qui reste au-dessus ne l est pas
--    tous les mois. Le balayage pose atteint et incremente generation dans UNE instruction gardee par
--    « not atteint », donc une seule copie gagne le franchissement ; la generation entre dans l occasion du journal des
--    envois. Les modeles du mois n en ont pas besoin : leur compteur repart chaque mois, l occasion porte le mois.
--    Tout s efface avec l espace.
--
-- ELLE AJOUTE SEULEMENT, DONC AVANT LE UP : l ancien code ne la lit pas et y survit.
set local lock_timeout = '5s';

create table if not exists emails_produit_seuils (
  tenant_id  uuid not null references tenants(id) on delete cascade,
  seuil      text not null check (char_length(seuil) between 1 and 60),
  atteint    boolean not null default false,
  generation integer not null default 0,
  maj_le     timestamptz not null default now(),
  primary key (tenant_id, seuil)
);
