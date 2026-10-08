-- 0220 : le numero inclus dans le Pro (lot 6, livraison B2b, plan docs/superpowers/plans/2026-10-07-offres-et-limites.md,
-- tache 12).
--
-- Deux colonnes sur abonnements_offre, que seul le code neuf ecrit et lit :
--  - rendre_numero : le client a choisi de rendre son numero fourni a la FIN de ce Pro (decision de Julien du
--    2026-10-07). A la fin, le numero seul n'est pas recree : il suit le chemin du lot 4 (envois coupes, 7 jours, puis
--    liberation). Reversible tant que le Pro court ; sur la ligne du Pro, parce qu'elle vaut pour CE Pro.
--  - suite_annoncee_le : l'e-mail qui annonce la suite du numero a la fin prevue du Pro (3,50 euros HT par mois sur la
--    meme carte, ou le rendre) est parti a cette date ; une fois par fin prevue, remise a vide quand la fin est retiree.
--
-- A appliquer AVANT le up : le code neuf lit et ecrit ces colonnes. L'ancien code y survit, il les ignore, et la colonne
-- NOT NULL a son defaut.
set local lock_timeout = '5s';

alter table abonnements_offre add column if not exists rendre_numero boolean not null default false;
alter table abonnements_offre add column if not exists suite_annoncee_le timestamptz;
